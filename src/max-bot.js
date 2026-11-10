// The MAX bot: the transport between the owner and the mainframe.
//
// Events arrive in two ways and only one at a time per bot token:
//   * webhook (production): POST /max/webhook, handled in web.js, calls handleMaxUpdate;
//   * long polling (local runs): GET /updates in a loop.
//
// MAX delivers every message of every chat the bot is in, and nothing else:
// there is no personal account here, and none is pretended.

import { config } from './config.js';
import { all, get, run, now, kvGet, kvSet, addLog } from './db.js';
import { bus } from './bus.js';
import { startRun, stopAll, resumeAll, stopRun, onRunFinished, onAllStopped, isPaused, replyInOwnerDialogue, replyInGroupDialogue } from './agent.js';
import { onInboxUpdate, forwardItem, replyItem, ignoreItem, getItem, handleMaxMessage } from './dispatcher.js';
import { fireTask, updateTask } from './scheduler.js';
import { setMainframeHandlers } from './mcp.js';
import { transcribeAudio, voiceEnabled } from './voice.js';
import { saveUpload, withAttachments } from './uploads.js';
import { completeReminder } from './apple.js';
import { refreshReport } from './social.js';
import { contentCallback } from './content.js';
import { listMemory, listPending, approvePending, rejectPending } from './memory.js';
import { listResearchMaterials, saveResearchMaterial } from './research.js';
import { MaxKeyboard } from './max-keyboard.js';
import {
  maxApi, maxState, setMaxState, sendMessage, replyTo, editMessage, deleteMessage,
  learnChatFromMessage, chatAllowed, typing, markSeen, refreshChatCount,
} from './max-chats.js';
import { messageId } from './max-api.js';
import {
  esc, body, dur, untok, MENU, menuFor, mainKeyboard, currentProject,
  homeScreen, inboxCard, screen, projectScreen, progressText,
} from './botui.js';

export const botState = { status: 'off', username: null, error: null };

// The owner: a MAX user id, and the chat where the replies go.
export const ownerId = () => config.max.ownerId || kvGet('owner_max_id', null);
const ownerChat = () => kvGet('owner_max_chat_id', null);

const cut = (s, n = 3800) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const HTML = 'html';

// Bot message -> what a reply to it should do. Old links are pruned after 30 days.
function remember(msg, { inboxId = null, projectId = null }) {
  const id = msg?.message?.body?.mid || msg?.message_id;
  if (!id) return;
  run('INSERT OR REPLACE INTO bot_msgs (message_id, inbox_id, project_id, created_at) VALUES (?, ?, ?, ?)', String(id), inboxId, projectId, now());
  run('DELETE FROM bot_msgs WHERE created_at < ?', now() - 30 * 86400000);
}

// Send a message with the keyboard attached. MAX strips unknown HTML, so a
// failed send is retried as plain text.
async function send(chatId, html, { kb = null, notify = true, replyToMid = null, disableLinkPreview = false } = {}) {
  const client = maxApi();
  if (!client) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  const attachments = kb?.toAttachment ? kb.toAttachment() : null;
  try {
    const res = await client.sendMessage(chatId, cut(html, 3900), {
      format: HTML,
      notify,
      disableLinkPreview,
      ...(attachments ? { attachments: [attachments] } : {}),
      ...(replyToMid ? { replyTo: replyToMid } : {}),
    });
    return res;
  } catch (e) {
    if (/format|markup|parse|entity/i.test(e.message)) {
      const plain = cut(String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      return client.sendMessage(chatId, plain, { notify, ...(attachments ? { attachments: [attachments] } : {}) });
    }
    throw e;
  }
}

export async function sendOwner(html, extra = {}) {
  const chat = ownerChat();
  if (!chat) throw new Error('Владелец не привязан: бот ещё не получил от него сообщение');
  return send(chat, html, extra);
}

// Edit a message in place. A message that cannot be edited is sent again.
async function edit(mid, text, kb = null) {
  const attachments = kb?.toAttachment ? kb.toAttachment() : null;
  try {
    await editMessage(mid, { text: cut(text, 3900), format: HTML, ...(attachments ? { attachments: [attachments] } : {}) });
    return true;
  } catch (e) {
    if (/not found|не найден/i.test(e.message)) return false;
    if (/message is not modified|не изменено/i.test(e.message)) return true;
    throw e;
  }
}

async function sendMenu(chatId, note) {
  const p = currentProject();
  const kb = mainKeyboard(p);
  return send(chatId, note || `🎯 Команды идут в <b>${esc(p.name)}</b>`, { kb });
}

async function showScreen(chatId, name, arg) {
  const s = await screen(name, arg);
  return send(chatId, s.text, { kb: s.kb });
}

// ---------- live progress of runs started from the bot ----------
const live = new Map(); // runId -> { chatId, userMsgId, msgId, timer, last, pending, lastText }

async function pushDraft(runId) {
  const t = live.get(runId);
  if (!t || t.done || !t.msgId) return;
  const r = get('SELECT * FROM runs WHERE id = ?', runId);
  if (!r || !['running', 'queued'].includes(r.status)) return;
  // Индикатор печати не гаснет, пока идёт работа.
  typing(t.chatId);
  const p = get('SELECT * FROM projects WHERE id = ?', r.project_id);
  const events = all("SELECT kind, content FROM run_events WHERE run_id = ? AND kind IN ('tool','text','error') ORDER BY id DESC LIMIT 5", runId).reverse();
  const steps = get("SELECT COUNT(*) c FROM run_events WHERE run_id = ? AND kind = 'tool'", runId).c;
  t.tick = (t.tick || 0) + 1;
  const text = progressText(p, r, events, steps, t.tick);
  if (text === t.lastText) return;
  t.lastText = text;
  await edit(t.msgId, text).catch((e) => addLog('error', `Статус работы: ${e.message.slice(0, 120)}`));
}

async function trackRun(runId, chatId, userMsgId, project) {
  const t = { chatId, userMsgId, msgId: null, timer: null, last: 0, pending: null, lastText: '' };
  live.set(runId, t);
  try {
    const m = await send(chatId, `💭 <b>Думаю</b>\n<i>${esc(project.name)} · 0:00</i>`, { notify: false });
    t.msgId = m?.message?.body?.mid || null;
  } catch (e) {
    addLog('error', `Статус работы: ${e.message.slice(0, 120)}`);
  }
  t.timer = setInterval(() => pushDraft(runId), 4000);
}

bus.on('change', (e) => {
  if (e.type !== 'run_event' || !live.has(e.id)) return;
  const t = live.get(e.id);
  if (t.pending) return;
  t.pending = setTimeout(() => { t.pending = null; pushDraft(e.id); }, 1200);
});

function untrack(runId) {
  const t = live.get(runId);
  if (!t) return null;
  t.done = true;
  clearInterval(t.timer);
  clearTimeout(t.pending);
  live.delete(runId);
  return t;
}

// ---------- memory screen ----------
function memoryScreen() {
  const notes = listMemory();
  const pending = listPending();
  const lines = [`🧠 <b>Память</b> · ${notes.length} заметок`, '<i>Полный список и поиск по истории: пульт → «Память».</i>'];
  if (pending.length) {
    lines.push('', `<b>На проверку: ${pending.length}</b>`);
    for (const n of pending.slice(0, 12)) lines.push(`• <b>${esc(n.title)}</b>\n<blockquote>${esc(cut(n.body, 600))}</blockquote>`);
  } else lines.push('', 'Новых заметок на проверку нет. Скажи «запомни, что…», и я сохраню сразу.');
  const kb = new MaxKeyboard();
  if (pending.length) kb.text('✅ Запомнить всё', 'mem:ok').text('❌ Отлонить всё', 'mem:no');
  return { text: lines.join('\n'), kb };
}

function resultMessage(r, project) {
  const icon = r.status === 'done' ? '✅' : r.status === 'stopped' ? '⏹' : '⚠️';
  const took = r.finished_at && r.started_at ? ` · ${dur(r.finished_at - r.started_at)}` : '';
  const task = /^\[Задача по расписанию «(.+?)»\]/.exec(r.prompt || '')?.[1];
  const head = `${icon} <b>${esc(project.name)}</b>${task ? ` · ⏰ ${esc(task)}` : ''}${took}`;
  const text = `${head}\n\n${body(r.result || (r.status === 'stopped' ? 'Остановлено' : r.status))}`;
  const kb = new MaxKeyboard();
  if (currentProject().id !== project.id) kb.text('🎯 Продолжать здесь', `sel:${project.id}`);
  return { text, kb };
}

// First-run interview: the session asks one question at a time and saves the answers to the
// shared memory, so every later session already knows who it works for.
const ONBOARDING_PROMPT = `Это первое знакомство с владельцем мейнфрейма. Проведи короткое интервью, чтобы потом работать на него без лишних вопросов.
Правила: задавай по одному вопросу за сообщение, коротко и по-человечески. После каждого ответа сразу сохрани факт через mainframe memory_save (без pending) и задавай следующий вопрос. Не больше 10 вопросов. Если человек пишет «хватит» или «потом», заканчивай.
Темы по порядку:
1. Как к нему обращаться, где живёт (город и часовой пояс), на каком языке общаться. (type user)
2. Чем занимается: работа, проекты, компании, роль. (type user и project)
3. Что продаёт или чем зарабатывает, цены и ссылки, куда вести людей. (type user, name offer)
4. Как писать от его имени: тон, длина, что нельзя (слова, тире, эмодзи), примеры его фраз. (type feedback, с «Почему» и «Как применять»)
5. Ключевые люди: партнёры, клиенты, семья, кому отвечать быстро. (type people, одна заметка на человека)
6. Что ему не нравится в работе помощников и что делать только после его «да». (type feedback)
7. Какие рутины он хочет отдать: сводки, напоминания, разбор почты, посты. Предложи поставить 1–3 задачи по расписанию через mainframe create_cron_task и поставь, если он согласен.
8. Есть ли канал и соцсети, сайт, бот продаж. (type reference)
В конце коротко перечисли, что запомнил, и подскажи 3 первые команды: «запомни, что…», задача голосом, /memory.
Начни с короткого приветствия в одну строку и первого вопроса.`;

// ---------- incoming updates ----------

// Every delivery of the same event must be processed once.
function seenUpdate(key) {
  if (!key) return false;
  const exists = get('SELECT update_id FROM max_updates WHERE update_id = ?', key);
  if (exists) return true;
  run('INSERT OR IGNORE INTO max_updates (update_id, update_type, created_at) VALUES (?, ?, ?)', key, 'x', now());
  run('DELETE FROM max_updates WHERE created_at < ?', now() - 7 * 86400000);
  return false;
}

// The owner writes a command: the message is a reply to one of our messages.
// The bot's own id, learned from GET /me. An admin with read_all_messages sees
// the bot's own messages too, and a card about our own reply is a loop.
const botUserId = () => kvGet('max_bot_id', null);

// The message a reply points to. MAX keeps it in link.message (the body of the
// replied message), and the id of that body is its mid.
export function linkedBotMessage(message) {
  const link = message?.link || message?.body?.link;
  const mid = link?.message?.mid || link?.mid || link?.message_id;
  if (!mid) return null;
  return get('SELECT * FROM bot_msgs WHERE message_id = ?', String(mid));
}

async function handleOwnerText(chatId, text, heard = '', { files = false, replyToMid = null } = {}) {
  const link = replyToMid ? get('SELECT * FROM bot_msgs WHERE message_id = ?', String(replyToMid)) : null;
  // Files never go to a person: a reply with a screenshot goes to the session.
  if (link?.inbox_id && !files) {
    const item = getItem(link.inbox_id);
    run('UPDATE inbox SET draft = ?, updated_at = ? WHERE id = ?', text, now(), item.id);
    const service = /no-?reply|notif|alert|bank|bidv|care@|support@|mailer|info@|billing|receipt/i.test(item.username || '');
    const kb = new MaxKeyboard();
    if (!service) kb.text(`✅ Отправить ${String(item.name || '').slice(0, 20)}`, `r:${item.id}`);
    kb.row().text('🧠 Это задача мейнфрейму', `tk:${item.id}`);
    return send(chatId, `${heard}${service ? `Это сервисная рассылка (${esc(item.username || item.name)}), отвечать туда нельзя.` : `Отправить это ${esc(item.name)}${item.source === 'mail' ? ' письмом' : ''} или это задача мне?`}\n\n<blockquote>${esc(text.slice(0, 800))}</blockquote>`, { kb });
  }
  if (!files && !heard && !replyToMid && /^(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер)[!.,\s👋]*$/iu.test(text.trim())) {
    return send(chatId, 'Привет! Чем помочь?');
  }
  if (!files && !heard && !replyToMid && /^(кто ты(?: и что (?:ты )?умеешь)?|что ты умеешь|что умеешь|что ты можешь)[?!.\s]*$/iu.test(text.trim())) {
    return send(chatId, 'Я ваш помощник на MiniMax. Могу исследовать вопрос, подготовить черновик для соцсетей и помочь с учебной задачей. Команда /material открывает список ваших материалов.');
  }
  if (!text.trim()) return send(chatId, 'Напишите, пожалуйста, что нужно сделать.');
  if (!files && !link?.project_id) {
    void typing(chatId);
    return send(chatId, body(await replyInOwnerDialogue(text)));
  }
  const p = (link?.project_id && get('SELECT * FROM projects WHERE id = ?', link.project_id)) || currentProject();
  if (heard) await send(chatId, heard);
  // Индикатор печати сразу: владелец сразу видит, что бот взялся за задачу.
  await typing(chatId);
  await markSeen(chatId);
  const runId = startRun({ projectId: p.id, prompt: text, origin: 'bot' });
  await trackRun(runId, chatId, null, p);
  return null;
}

let requestBotRestart = null;

const postPrompt = (text) => `Подготовь готовый черновик поста. По умолчанию площадка MAX. Используй правила копирайтинга и форматирования. ${/(?:найди|поиск|источник|интернет|проверь)/iu.test(text) ? '' : 'Используй предоставленные сведения без поиска.'} Запрос:\n${text}`;
const groupUsage = 'Включение владельцем в нужном чате: /group on. После этого участники могут писать /ask вопрос или /post тема. Отключение: /group off.';

// A command from the owner.
async function handleCommand(chatId, text) {
  const [raw, ...rest] = text.trim().split(/\s+/);
  // In a group the command may address the bot: /menu@MyFrame.
  const cmd = raw.split('@')[0].toLowerCase();
  const arg = rest.join(' ');
  const p = currentProject();
  switch (cmd.toLowerCase()) {
    case '/start': return showScreen(chatId, 'home');
    case '/help': return send(chatId, ['<b>Команды Мейнфрейма</b>', ...COMMANDS.map(({ command, description }) => `<code>/${command}</code> · ${esc(description)}`)].join('\n'));
    case '/group': return send(chatId, groupUsage);
    case '/ask': return arg ? handleOwnerText(chatId, arg) : send(chatId, 'Напишите /ask и ваш вопрос.');
    case '/post': {
      if (!arg) return send(chatId, 'Напишите /post и тему или вставьте исходный текст.');
      return send(chatId, body(await replyInOwnerDialogue(postPrompt(text.trim().slice(raw.length).trim())), { fold: Infinity }));
    }
    case '/menu': await sendMenu(chatId); return showScreen(chatId, 'home');
    case '/app': return send(chatId, config.max.publicUrl?.startsWith('https://')
      ? '📱 Пульт:' : 'Нет https-адреса для пульта. Задай PUBLIC_URL.', {
      kb: config.max.publicUrl?.startsWith('https://') ? new MaxKeyboard().url('Открыть пульт', config.max.publicUrl) : null,
    });
    case '/status': return showScreen(chatId, 'home');
    case '/inbox': return showScreen(chatId, 'inbox');
    case '/today': return showScreen(chatId, 'today');
    case '/projects': return showScreen(chatId, 'sess');
    case '/social': return showScreen(chatId, 'soc');
    case '/tasks': return showScreen(chatId, 'tasks');
    case '/memory': { const m = memoryScreen(); return send(chatId, m.text, { kb: m.kb }); }
    case '/material': {
      if (!arg) {
        const titles = listResearchMaterials().map((item) => `• ${esc(item.title)}`);
        return send(chatId, [...titles, 'Чтобы добавить или обновить материал, напишите /material Название | текст.'].join('\n'));
      }
      const input = text.trim().slice(raw.length).trim();
      const separator = input.indexOf('|');
      if (separator === -1) return send(chatId, 'Формат: /material Название | текст');
      try {
        const material = saveResearchMaterial(input.slice(0, separator), input.slice(separator + 1));
        return send(chatId, `Материал сохранён: ${esc(material.title)}. Упомяните его название в вопросе.`);
      } catch (error) {
        return send(chatId, esc(error.message));
      }
    }
    case '/stop': stopAll(); return send(chatId, '⏹ <b>Всё остановил.</b> Автоматика на паузе.', { kb: new MaxKeyboard().text('▶️ Включить', 'sys:resume') });
    case '/resume': resumeAll(); return send(chatId, '▶️ Автоматика включена.');
    case '/restart': {
      if (!requestBotRestart) return send(chatId, 'Перезапуск из чата недоступен.');
      await send(chatId, 'Перезапущусь, когда закончатся текущие задачи. Личный диалог начнётся заново.');
      requestBotRestart();
      return;
    }
    case '/setup': {
      const runId = startRun({ projectId: p.id, prompt: `${ONBOARDING_PROMPT}\nВ памяти уже есть заметки (mainframe memory_list): не спрашивай то, что там уже есть, уточни только пробелы.`, origin: 'bot' });
      return trackRun(runId, chatId, null, p);
    }
    case '/new': {
      const [name, rawCwd] = arg.split('|').map((s) => s.trim());
      if (!name) return send(chatId, 'Формат: <code>/new Название | /путь/к/папке</code>');
      const cwd = rawCwd?.replace(/^~(?=\/)/, process.env.HOME);
      if (cwd && !cwd.startsWith('/')) return send(chatId, 'Папка должна быть полным путём: /Users/… или ~/…');
      const res = run('INSERT INTO projects (name, cwd, created_at) VALUES (?, ?, ?)', name, cwd || `${config.workspaceDir}/${name}`, now());
      kvSet('bot_project', Number(res.lastInsertRowid));
      return sendMenu(chatId, `🆕 Проект <b>${esc(name)}</b> создан, команды идут туда.`);
    }
    case '/audience': {
      // The people the bot can reach: the members of the chats it is in.
      const { reach } = await import('./max-chats.js');
      const r = reach();
      const lines = ['👥 <b>Доступная аудитория</b>', '', `Чатов и каналов, где я состою: <b>${r.chats.length}</b>`, `Людей, которых вижу: <b>${r.people}</b>`, ''];
      for (const c of r.chats.slice(0, 30)) lines.push(`• ${esc(c.title)} <code>${esc(c.chatId)}</code> · ${c.type} · известно участников: ${c.knownMembers}`);
      if (!r.chats.length) lines.push('<i>Пока нигде не состою. Добавь меня в чат или канал.</i>');
      return send(chatId, lines.join('\n'));
    }
    default:
      return send(chatId, `Не знаю команду ${esc(cmd)}. Доступные команды: ${COMMANDS.map(({ command }) => `/${command}`).join(', ')}.`);
  }
}

// A text message from somebody who is not the owner.
async function handleForeignText(chatId, text, message) {
  const contact = get('SELECT * FROM contacts WHERE chat_id = ?', chatId);
  if (contact?.mode === 'ignore') return;
  await handleMaxMessage({
    chatId,
    text,
    name: message?.sender ? [message.sender.first_name, message.sender.last_name].filter(Boolean).join(' ') : '',
    username: message?.sender?.username || null,
    externalId: messageId(message),
    chatType: message?.recipient?.chat_type || 'dialog',
    chatTitle: null,
  });
}

async function handleVoice(chatId, message) {
  if (!voiceEnabled()) return send(chatId, 'Расшифровка голосовых выключена (WHISPER_URL=off).');
  const audio = (message?.body?.attachments || []).find((a) => a.type === 'audio');
  if (!audio?.url) return send(chatId, '⚠️ Не нашёл аудиофайл в голосовом.');
  let text;
  try {
    const res = await fetch(audio.url);
    if (!res.ok) throw new Error(`MAX не отдал файл (${res.status})`);
    text = await transcribeAudio(Buffer.from(await res.arrayBuffer()), 'voice.mp3');
  } catch (e) {
    addLog('error', `Голосовое боту: ${e.message}`);
    return send(chatId, `⚠️ Не смог расшифровать: ${esc(e.message)}`);
  }
  addLog('bot', 'Голосовое расшифровано');
  return handleOwnerText(chatId, text, `🎤 <i>${esc(text)}</i>`);
}

async function handleFiles(chatId, message) {
  const attachments = message?.body?.attachments || [];
  const files = [];
  for (const a of attachments) {
    if (!['image', 'video', 'audio', 'file'].includes(a.type) || !a.url) continue;
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const name = a.filename || `file-${Date.now()}`;
      files.push(saveUpload(name, Buffer.from(await res.arrayBuffer())));
    } catch (e) {
      addLog('error', `Файл из MAX: ${e.message}`);
    }
  }
  if (!files.length) return null;
  const caption = message?.body?.text || '';
  return handleOwnerText(chatId, withAttachments(caption, files), '', { files: true });
}

// A button press.
async function handleCallback(update) {
  const cb = update.callback || {};
  const payload = String(cb.payload || '');
  const chatId = String(update.message?.recipient?.chat_id || cb.chat_id || '');
  const userId = cb.user?.user_id ? String(cb.user.user_id) : '';
  const [kind, a, b] = payload.split(':');
  let toast;
  try {
    // Only the owner acts on the buttons: they send answers to other people and
    // start sessions. Without a paired owner nobody may press anything.
    const owner = ownerId();
    if (!owner) throw new Error('Бот ещё не привязан к владельцу.');
    if (!userId || userId !== String(owner)) throw new Error('Это не владелец.');
    // The original message can be gone by the time the button is pressed.
    const mid = messageId(update.message);
    if (!mid) throw new Error('Сообщение с кнопкой уже удалено.');
    if (kind === 'n') {
      const s = await screen(a);
      await edit(mid, s.text, s.kb);
    } else if (kind === 'c') {
      const item = getItem(Number(a));
      if (item) {
        const card = inboxCard(item, 'view');
        await edit(mid, card.text, card.kb);
      }
    } else if (kind === 's') {
      const s = projectScreen(Number(a));
      await edit(mid, s.text, s.kb);
    } else if (kind === 'sel' || kind === 'p') {
      kvSet('bot_project', Number(a));
      toast = `Команды идут в «${currentProject().name}»`;
      await sendMenu(chatId);
    } else if (kind === 'ns') {
      run('UPDATE projects SET session_id = NULL WHERE id = ?', Number(a));
      bus.change('project', Number(a));
      toast = 'Следующее сообщение начнёт новую сессию';
    } else if (kind === 'f') {
      await forwardItem(Number(a), { projectId: Number(b), approved: true });
      toast = `Отправил в «${get('SELECT name FROM projects WHERE id = ?', Number(b))?.name}»`;
      const card = inboxCard(getItem(Number(a)), 'view');
      await edit(mid, card.text, card.kb);
    } else if (kind === 'pick') {
      const kb = new MaxKeyboard();
      for (const p of all('SELECT id, name FROM projects ORDER BY is_default DESC, name')) kb.text(p.name.slice(0, 30), `f:${a}:${p.id}`).row();
      kb.text('← Назад', `c:${a}`);
      await edit(mid, cardOrKeep(update.message), kb);
    } else if (kind === 'tk') {
      const item = getItem(Number(a));
      const p = currentProject();
      const prompt = `Владелец написал про ${item.source === 'mail' ? 'письмо' : 'сообщение'} от ${item.name}${item.username ? ` (${item.username})` : ''}:\n«${item.draft || ''}»\n\nСамо ${item.source === 'mail' ? 'письмо' : 'сообщение'}:\n"""\n${String(item.text || '').slice(0, 2000)}\n"""\n\nЭто указание тебе, а не ответ отправителю. Отправителю ничего не пиши.`;
      run('UPDATE inbox SET draft = NULL WHERE id = ?', item.id);
      const runId = startRun({ projectId: p.id, prompt, origin: 'bot' });
      await trackRun(runId, chatId, null, p);
      toast = `Задача ушла в «${p.name}»`;
    } else if (kind === 'r') {
      const item = await replyItem(Number(a));
      toast = `Ответил ${item.name}`;
      const card = inboxCard(getItem(Number(a)), 'view');
      await edit(mid, card.text, card.kb);
    } else if (kind === 'i') {
      ignoreItem(Number(a));
      const card = inboxCard(getItem(Number(a)), 'view');
      await edit(mid, card.text, card.kb);
    } else if (kind === 'x') {
      stopRun(Number(a));
      toast = 'Остановлено';
    } else if (kind === 't') {
      fireTask(Number(a), true);
      toast = 'Запустил, итог пришлю';
    } else if (kind === 'tt') {
      const t = get('SELECT * FROM tasks WHERE id = ?', Number(a));
      if (t) updateTask(t.id, { enabled: t.enabled ? 0 : 1 });
      const s = await screen('tasks');
      await edit(mid, s.text, s.kb);
    } else if (kind === 'soc') {
      refreshReport();
      toast = 'Собираю сводку, 1–3 минуты';
      const s = await screen('soc');
      await edit(mid, s.text, s.kb);
    } else if (kind === 'rc') {
      const id = untok(a);
      if (!id) throw new Error('Кнопка устарела, открой «Сегодня» заново');
      await completeReminder(id);
      toast = 'Выполнено';
      const s = await screen('today');
      await edit(mid, s.text, s.kb);
    } else if (kind === 'mem') {
      const items = listPending();
      for (const n of items) (a === 'ok' ? approvePending : rejectPending)(n.name);
      toast = a === 'ok' ? `Запомнил: ${items.length}` : `Отклонил: ${items.length}`;
      const m = memoryScreen();
      await edit(mid, m.text, m.kb);
    } else if (kind === 'cpok' || kind === 'cpx' || kind === 'cpn' || kind === 'cpd') {
      toast = await contentCallback(kind, a);
    } else if (kind === 'sys') {
      if (a === 'stop') { stopAll(); toast = 'Всё остановлено'; } else { resumeAll(); toast = 'Автоматика включена'; }
      const s = await screen('sys');
      await edit(mid, s.text, s.kb);
    }
    await maxApi()?.answerCallback(cb.callback_id, { notification: toast || undefined });
  } catch (e) {
    await maxApi()?.answerCallback(cb.callback_id, { notification: cut(e.message, 190) }).catch(() => {});
  }
}

// Keep the text of a message when only the keyboard changes.
const cardOrKeep = (message) => message?.body?.text || '';

// Pairing: the owner starts the bot and passes the code from the dashboard.
async function tryPair(chatId, userId, payload) {
  const code = String(payload || '').trim();
  if (!code || code !== config.pairingCode) {
    await send(chatId, 'Чтобы привязать бота, отправь /start и код с дашборда.');
    return true;
  }
  kvSet('owner_max_id', String(userId));
  kvSet('owner_max_chat_id', String(chatId));
  addLog('system', `Бот привязан к MAX ${userId}`);
  await send(chatId, '🔗 <b>Бот привязан к тебе.</b> Меню и задачи — прямо сюда.');
  if (!listMemory().length) {
    const p = currentProject();
    const runId = startRun({ projectId: p.id, prompt: ONBOARDING_PROMPT, origin: 'bot' });
    await trackRun(runId, String(chatId), null, p);
  }
  return true;
}

// The entry point of every event, from webhook and from long polling.
const groupWorking = new Map();
const groupCooldown = new Map();
let groupRestarting = false;
export const activeGroupCount = () => groupWorking.size;
export const beginGroupRestart = () => { groupRestarting = true; };
function stopGroupWork() {
  for (const controller of groupWorking.values()) controller.abort();
}
onAllStopped(stopGroupWork);

async function handleGroupCommand(message, chatId, isOwner, background) {
  const text = message.body?.text?.trim() || '';
  const command = /^\/(group|ask|post|help)(?:@([\w.]+))?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!command) return false;
  const [, raw, addressedTo, arg = ''] = command;
  if (addressedTo && addressedTo.toLowerCase() !== botState.username?.toLowerCase()) return true;
  const name = raw.toLowerCase();
  const key = `max_group_assistant:${chatId}`;
  if (name === 'group') {
    if (!isOwner) return true;
    const mode = arg.trim().toLowerCase();
    if (mode === 'on' || mode === 'off') kvSet(key, mode === 'on');
    if (mode === 'off') groupWorking.get(chatId)?.abort();
    await send(chatId, kvGet(key, false) ? `Помощник в этой группе включён. ${groupUsage}` : `Помощник в этой группе выключен. ${groupUsage}`);
    return true;
  }
  if (!kvGet(key, false)) return true;
  if (name === 'help' || !arg.trim()) {
    await send(chatId, 'Напишите /ask и вопрос или /post и тему для черновика. Для поиска используйте публичные сведения.');
    return true;
  }
  if (isPaused() || groupRestarting || groupWorking.size >= 2 || groupWorking.has(chatId) || Date.now() < (groupCooldown.get(chatId) || 0)) return true;
  const controller = new AbortController();
  groupWorking.set(chatId, controller);
  groupCooldown.set(chatId, Date.now() + 20000);
  if (groupCooldown.size > 100) groupCooldown.delete(groupCooldown.keys().next().value);
  const work = async () => {
    try {
      void typing(chatId);
      const answer = await replyInGroupDialogue(name === 'post' ? postPrompt(arg) : arg, controller.signal);
      if (!controller.signal.aborted && kvGet(key, false)) await send(chatId, body(answer || 'Ответ не получен. Попробуйте уточнить вопрос.', { fold: name === 'post' ? Infinity : 650 }));
    } catch {
      addLog('error', 'Не удалось обработать команду помощника в группе MAX');
      if (!controller.signal.aborted && kvGet(key, false)) await send(chatId, 'Не удалось подготовить ответ. Попробуйте позже.').catch(() => {});
    } finally {
      groupWorking.delete(chatId);
    }
  };
  if (background) void work();
  else await work();
  return true;
}

export async function handleMaxUpdate(update, { backgroundGroup = false } = {}) {
  if (!update || typeof update !== 'object') return;
  const type = update.update_type;
  const key = type === 'message_created'
    ? `mc:${messageId(update.message)}`
    : type === 'message_callback'
      ? `cb:${update.callback?.callback_id || update.callback?.timestamp}`
      : type === 'bot_started'
        ? `bs:${update.chat_id}:${update.user?.user_id}:${update.timestamp}`
        : null;
  if (key && seenUpdate(key)) return;

  if (type === 'message_created') {
    const message = update.message;
    learnChatFromMessage(message);
    const chatId = String(message?.recipient?.chat_id || '');
    const userId = message?.sender?.user_id ? String(message.sender.user_id) : '';
    const isOwner = ownerId() && userId === String(ownerId());
    const ownerDialog = isOwner && message?.recipient?.chat_type === 'dialog';
    if (ownerDialog && chatId) kvSet('owner_max_chat_id', chatId);
    if (!chatAllowed(chatId)) return;
    // Our own message: an admin with read_all_messages sees them too, and a
    // card about our own reply would start a loop.
    if (userId && botUserId() && userId === String(botUserId())) return;
    const chatType = message?.recipient?.chat_type;
    if (chatId && userId && chatType === 'chat' && !message.sender?.is_bot
      && await handleGroupCommand(message, chatId, isOwner, backgroundGroup)) return;
    if (['chat', 'channel'].includes(chatType) && process.env.MAX_GROUP_INBOX !== '1') return;

    const text = message?.body?.text || '';
    const attachments = message?.body?.attachments || [];

    // Not paired yet: the owner starts the bot with the code from the dashboard.
    if (!ownerId() && text.trim().startsWith('/start')) {
      return tryPair(chatId, userId, text.trim().split(/\s+/).slice(1).join(' '));
    }
    // Commands live in the private chat with the owner.
    if (ownerDialog && text.startsWith('/')) {
      return handleCommand(chatId, text);
    }
    // A reply to one of our messages: either a reply to a person or a new task.
    const linked = linkedBotMessage(message);
    if (ownerDialog && linked) {
      return handleOwnerText(chatId, text, '', { replyToMid: linked.message_id });
    }
    if (isOwner && attachments.length) {
      if (message?.recipient?.chat_type !== 'dialog') return handleFiles(chatId, message);
      if (attachments.every((a) => a.type === 'audio')) return handleVoice(chatId, message);
      return send(chatId, 'В личном чате я не сохраняю вложения. Напишите задачу текстом.');
    }
    if (ownerDialog) {
      // The menu buttons come as plain text of the menu.
      const menu = menuFor(text.trim());
      if (menu) {
        const map = { home: 'home', inbox: 'inbox', today: 'today', sessions: 'sess', social: 'soc', more: 'sys' };
        return showScreen(chatId, map[menu]);
      }
      return handleOwnerText(chatId, text);
    }
    // Everybody else: an incoming message for the dispatcher.
    if (text || attachments.length) {
      return handleForeignText(chatId, text, message);
    }
    return undefined;
  }

  if (type === 'message_callback') return handleCallback(update);
  if (type === 'bot_started') {
    const userId = update.user?.user_id ? String(update.user.user_id) : '';
    if (!ownerId()) {
      return tryPair(String(update.chat_id), userId, update.payload);
    }
    if (userId === String(ownerId())) {
      kvSet('owner_max_chat_id', String(update.chat_id));
      return showScreen(String(update.chat_id), 'home');
    }
    return undefined;
  }
  if (type === 'bot_added' || type === 'user_added' || type === 'bot_admin_permissions_changed') {
    if (update.chat_id) {
      const { rememberChat } = await import('./max-chats.js');
      rememberChat({ chat_id: update.chat_id, type: update.is_channel ? 'channel' : 'chat' });
    }
    return undefined;
  }
  return undefined;
}

// ---------- long polling ----------

let pollTimer = null;
let polling = false;

async function pollOnce() {
  const client = maxApi();
  if (!client) return;
  const marker = kvGet('max_update_marker', null);
  const data = await client.getUpdates({ limit: 100, timeout: 25, marker: marker ?? undefined, types: 'message_created,message_callback,bot_started,bot_added,user_added' });
  const updates = Array.isArray(data?.updates) ? data.updates : [];
  for (const update of updates) {
    try {
      await handleMaxUpdate(update, { backgroundGroup: true });
    } catch (e) {
      addLog('error', `Событие MAX: ${e.message.slice(0, 200)}`);
    }
  }
  // The marker is saved only after the events are handled: MAX counts every
  // update before the marker as read, so saving it earlier would drop the
  // events of a run that crashed halfway through.
  if (data?.marker !== undefined && data?.marker !== null) kvSet('max_update_marker', data.marker);
  if (updates.length) addLog('system', `MAX: получено событий ${updates.length}`);
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  while (polling) {
    try {
      await pollOnce();
      setMaxState({ connected: true, error: null });
    } catch (e) {
      // The cause of a network error ("fetch failed") is in e.cause: without it
      // the reason of the failure stays unknown.
      const why = e?.cause?.code || e?.cause?.message || e?.message;
      setMaxState({ connected: false, error: String(why).slice(0, 200) });
      addLog('error', `Опрос MAX: ${why}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------- start ----------

const COMMANDS = [
  { command: 'start', description: 'Открыть главное меню' },
  { command: 'help', description: 'Список всех команд' },
  { command: 'material', description: 'Материалы для исследования' },
  { command: 'post', description: 'Подготовить черновик поста' },
  { command: 'ask', description: 'Задать вопрос помощнику' },
  { command: 'restart', description: 'Перезапустить бота после завершения текущих задач' },
  { command: 'group', description: 'Включить или выключить помощника в группе' },
  { command: 'menu', description: 'Пульт и меню' },
  { command: 'status', description: 'Статус бота и подключений' },
  { command: 'inbox', description: 'Входящие' },
  { command: 'today', description: 'Встречи и напоминания' },
  { command: 'projects', description: 'Сессии: куда идут команды' },
  { command: 'social', description: 'Соцсети и советы' },
  { command: 'tasks', description: 'Задачи по расписанию' },
  { command: 'memory', description: 'Память: что я знаю, одобрить новое' },
  { command: 'audience', description: 'Кого я вижу: чаты и участники' },
  { command: 'setup', description: 'Знакомство: рассказать о себе' },
  { command: 'app', description: 'Открыть пульт' },
  { command: 'new', description: 'Новый проект: Название | путь' },
  { command: 'stop', description: 'Остановить задачи и приостановить автоматику' },
  { command: 'resume', description: 'Включить автоматику' },
];

export async function startBot({ requestRestart = null } = {}) {
  requestBotRestart = requestRestart;
  if (!config.max.token) {
    botState.status = 'not_configured';
    setMaxState({ mode: 'off' });
    return;
  }
  const client = maxApi();
  try {
    const me = await client.getMe();
    botState.status = 'running';
    botState.username = me?.username || null;
    // The id of the bot itself: its own messages must not become incoming cards.
    if (me?.user_id) kvSet('max_bot_id', String(me.user_id));
    refreshChatCount();
    setMaxState({ mode: config.max.longPolling ? 'polling' : 'webhook', connected: true, account: me?.username ? `@${me.username}` : null, error: null });
    addLog('system', `Бот MAX ${me?.username ? `@${me.username}` : ''} запущен`);
  } catch (e) {
    botState.status = 'error';
    botState.error = e.message;
    setMaxState({ error: e.message });
    addLog('error', `Бот MAX не запустился: ${e.message}`);
    return;
  }
  try {
    await client.setCommands(COMMANDS, AbortSignal.timeout(12000));
    const { commands = [] } = await client.getMe(AbortSignal.timeout(12000));
    if (COMMANDS.some(({ command }, index) => commands[index]?.name !== command)) {
      addLog('error', 'MAX вернул неполный список команд после обновления');
    }
  } catch {
    addLog('error', 'Не удалось обновить или проверить список команд MAX');
  }

  if (config.max.longPolling) {
    pollLoop();
  } else {
    setMaxState({ mode: 'webhook' });
    // Production: the webhook is registered by the operator (or by the
    // MAX_WEBHOOK_URL setting) and events arrive through web.js.
    if (config.max.publicUrl?.startsWith('https://')) {
      const url = `${config.max.publicUrl.replace(/\/+$/, '')}/max/webhook`;
      await client.subscribe({ url, secret: config.max.webhookSecret }).catch((e) => addLog('error', `Подписка MAX: ${e.message}`));
    }
  }

  onInboxUpdate(async (item, reason) => {
    if (item.source === 'group' && process.env.MAX_GROUP_INBOX !== '1') return;
    // No notifications for items that need no action.
    if (reason === 'noted') return;
    if (!ownerChat()) return;
    const { text, kb } = inboxCard(item, reason);
    // Индикатор печати: владелец видит, что бот работает.
    await typing(ownerChat());
    const msg = await sendOwner(text, { kb });
    remember(msg, { inboxId: item.id });
  });

  onRunFinished(async (r, project) => {
    const t = untrack(r.id);
    if (t?.msgId) await deleteMessage(t.msgId).catch(() => {});
    if (!ownerChat() || r.inbox_id || r.origin === 'ui') return;
    const chat = t?.chatId || ownerChat();
    const { text, kb } = resultMessage(r, project);
    await typing(chat);
    const msg = await send(chat, text, { kb });
    remember(msg, { projectId: project.id });
  });

  setMainframeHandlers({ notify: (md) => sendOwner(`🔔 ${body(md)}`) });
}

export function stopBot() {
  polling = false;
  if (pollTimer) clearTimeout(pollTimer);
}
