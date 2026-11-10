// The MAX side of the mainframe: the chats and channels the bot is in, their
// members and the messages the bot is allowed to see.
//
// MAX Bot API has no "list all my chats" endpoint any more (it was removed in
// June 2026). The set of chats is therefore learned from incoming events and
// from the chats the owner names explicitly. Nothing here pretends to reach a
// personal account: the bot only ever sees what it was added to.

import { config } from './config.js';
import { MaxApi, messageId, messageText } from './max-api.js';
import { all, get, run, now, addLog } from './db.js';
import { bus } from './bus.js';

export const maxState = {
  mode: 'off',            // off | polling | webhook
  connected: false,
  account: null,          // bot name / user id
  error: null,
  chats: 0,
  lastUpdateAt: null,
};

let api = null;

export function maxApi() {
  if (!config.max.token) return null;
  if (!api) api = new MaxApi({ token: config.max.token, baseUrl: config.max.apiUrl });
  return api;
}

export function setMaxState(patch) {
  Object.assign(maxState, patch);
  // The dashboard watches this event to refresh the "System" tab at once.
  bus.change('max');
}

// ---- chat registry -------------------------------------------------------

const CHAT_COLUMNS = ['type', 'title', 'username', 'status', 'participants_count', 'is_public', 'is_admin', 'messages_count', 'last_event_time'];

// Store what we know about a chat. Unknown fields are left untouched.
export function rememberChat(chat) {
  if (!chat?.chat_id) return null;
  const chatId = String(chat.chat_id);
  const existing = knownChat(chatId);
  const patch = {};
  for (const key of CHAT_COLUMNS) {
    if (chat[key] !== undefined && chat[key] !== null) patch[key] = chat[key];
  }
  if (!existing) {
    run(
      `INSERT INTO max_chats (chat_id, ${CHAT_COLUMNS.join(', ')}, first_seen, updated_at)
       VALUES (?, ${CHAT_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      chatId,
      ...CHAT_COLUMNS.map((k) => patch[k] ?? null),
      now(), now(),
    );
  } else {
    const keys = Object.keys(patch);
    if (keys.length) {
      run(`UPDATE max_chats SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE chat_id = ?`,
        ...keys.map((k) => patch[k]), now(), chatId);
    }
  }
  refreshChatCount();
  return knownChat(chatId);
}

export const knownChats = () => all('SELECT * FROM max_chats ORDER BY type, title');
export const knownChat = (chatId) => get('SELECT * FROM max_chats WHERE chat_id = ?', String(chatId));

// The count of the known chats is shown in the dashboard, so it has to be
// right right after the start and not only after the first event.
export function refreshChatCount() {
  maxState.chats = get('SELECT COUNT(*) c FROM max_chats').c;
}

// Which chats the bot answers in. An empty MAX_ALLOWED_CHATS means every chat
// the bot is in.
export function chatAllowed(chatId) {
  if (!chatId) return false;
  const allowed = config.max.allowedChats;
  if (!allowed.length) return true;
  return allowed.includes(String(chatId));
}

// Learn the chat from an incoming message: recipient carries chat_id and type.
export function learnChatFromMessage(message) {
  const recipient = message?.recipient;
  if (!recipient?.chat_id) return null;
  const known = knownChat(recipient.chat_id);
  const chat = {
    chat_id: recipient.chat_id,
    type: recipient.chat_type,
    last_event_time: message?.timestamp || null,
  };
  if (!known?.title && recipient.chat_type !== 'dialog') {
    // The title arrives later, from GET /chats/{id}.
    chat.title = null;
  }
  return rememberChat(chat);
}

// ---- members and audience -------------------------------------------------

const rememberMember = (chatId, user) => {
  if (!user?.user_id) return;
  run(
    `INSERT INTO max_members (chat_id, user_id, first_name, last_name, username, is_bot, is_admin, is_owner, join_time, last_access_time, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET
       first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
       is_bot = excluded.is_bot, is_admin = excluded.is_admin, is_owner = excluded.is_owner,
       join_time = excluded.join_time, last_access_time = excluded.last_access_time, updated_at = excluded.updated_at`,
    String(chatId), String(user.user_id),
    user.first_name ?? null, user.last_name ?? null, user.username ?? null,
    user.is_bot ? 1 : 0, user.is_admin ? 1 : 0, user.is_owner ? 1 : 0,
    user.join_time ?? null, user.last_access_time ?? null, now(),
  );
};

// Members of a chat. The bot can only read members of chats it is in, and the
// method itself is limited by MAX, so a failure is reported, not hidden.
export async function members(chatId, { count = 100, marker } = {}) {
  const client = maxApi();
  if (!client) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  const data = await client.getMembers(chatId, { count, marker });
  const list = Array.isArray(data?.members) ? data.members : [];
  for (const m of list) rememberMember(chatId, m);
  return {
    members: list.map((m) => ({
      userId: String(m.user_id),
      name: [m.first_name, m.last_name].filter(Boolean).join(' '),
      username: m.username || null,
      isBot: Boolean(m.is_bot),
      isAdmin: Boolean(m.is_admin),
      isOwner: Boolean(m.is_owner),
    })),
    marker: data?.marker ?? null,
  };
}

export const admins = (chatId) => maxApi()?.getAdmins(chatId);
export const memberMe = (chatId) => maxApi()?.getMemberMe(chatId);

// Everyone the bot can address: the union of the members of the chats it is in.
export function audience() {
  return all(`SELECT m.user_id, m.first_name, m.last_name, m.username, m.is_bot, m.is_admin,
                    GROUP_CONCAT(DISTINCT m.chat_id) AS chats, COUNT(DISTINCT m.chat_id) AS chat_count
             FROM max_members m
             GROUP BY m.user_id
             ORDER BY chat_count DESC, m.user_id`)
    .map((m) => ({
      userId: m.user_id,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.username || m.user_id,
      username: m.username || null,
      isBot: Boolean(m.is_bot),
      isAdmin: Boolean(m.is_admin),
      chats: (m.chats || '').split(',').filter(Boolean),
    }));
}

// A snapshot of what the bot may reach: chats, their type and how many members are known.
export function reach() {
  const chats = knownChats().map((c) => ({
    chatId: c.chat_id,
    type: c.type,
    title: c.title || (c.type === 'dialog' ? 'личный чат' : c.chat_id),
    username: c.username || null,
    participants: c.participants_count ?? null,
    knownMembers: get('SELECT COUNT(*) c FROM max_members WHERE chat_id = ?', c.chat_id).c,
    allowed: chatAllowed(c.chat_id),
  }));
  return { chats, people: audience().length };
}

// ---- messages -------------------------------------------------------------

const normalize = (m) => ({
  id: messageId(m),
  chatId: String(m?.recipient?.chat_id ?? ''),
  chatType: m?.recipient?.chat_type || null,
  text: messageText(m),
  senderId: m?.sender?.user_id ? String(m.sender.user_id) : null,
  senderName: m?.sender ? [m.sender.first_name, m.sender.last_name].filter(Boolean).join(' ') : null,
  senderUsername: m?.sender?.username || null,
  // MAX counts the time in seconds. Milliseconds are made where they are needed.
  timestamp: m?.timestamp || null,
  // Views are given only for channels, and only to a bot with the view_stats
  // permission (MAX grants it to the owner of the channel). For other chats the
  // field is null - that is the answer, not a missing number.
  views: m?.stat?.views ?? null,
  // The public link of the message. It is null for dialogs and non-public chats.
  url: m?.url || null,
});

export async function listMessages(chatId, { count = 50, after, before } = {}) {
  const client = maxApi();
  if (!client) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  // The API takes at most 100 messages per request and answers 400 on a bigger number.
  const size = Math.max(1, Math.min(Number(count) || 50, 100));
  const data = await client.getMessages(chatId, { count: size, after, before });
  const list = Array.isArray(data?.messages) ? data.messages : [];
  // The API answers newest first; the app reads oldest first.
  return list.map(normalize).reverse();
}

// The messages after a moment in time. The API takes `after` as a timestamp
// (Unix seconds), not as an id of a message.
export const getMessagesAfter = (chatId, afterTs, count = 50) => listMessages(chatId, { count, after: afterTs });

export async function getChat(chatId) {
  const client = maxApi();
  if (!client) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  const chat = await client.getChat(chatId);
  if (chat?.chat_id) {
    rememberChat({
      chat_id: chat.chat_id,
      type: chat.type,
      title: chat.title,
      status: chat.status,
      participants_count: chat.participants_count,
      is_public: chat.is_public ? 1 : 0,
      messages_count: chat.messages_count,
      last_event_time: chat.last_event_time,
    });
  }
  return chat;
}

export const sendMessage = (chatId, text, options = {}) => {
  const client = maxApi();
  if (!client) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  return client.sendMessage(chatId, text, options);
};

export const replyTo = (chatId, mid, text, options = {}) =>
  sendMessage(chatId, text, { ...options, replyTo: mid });

export const editMessage = (messageId, body) => {
  const client = maxApi();
  if (!client) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  return client.editMessage(messageId, body);
};

// The typing indicator at the top of the chat: the owner sees that the bot is
// working. The action is a normal request, it fails quietly.
export async function typing(chatId) {
  const client = maxApi();
  if (!client || !chatId) return null;
  try {
    return await client.sendAction(chatId, 'typing_on');
  } catch (e) {
    addLog('error', `Индикатор печати: ${e.message.slice(0, 120)}`);
    return null;
  }
}

// The chat is marked as read by the bot.
export async function markSeen(chatId) {
  const client = maxApi();
  if (!client || !chatId) return null;
  try {
    return await client.sendAction(chatId, 'mark_seen');
  } catch {
    return null;
  }
}

export const deleteMessage = (messageId) => {
  const client = maxApi();
  if (!client) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  return client.deleteMessage(messageId);
};

// Refresh the member list of every known chat. Used by the audience command.
export async function refreshAudience() {
  const chats = knownChats().filter((c) => c.type && c.type !== 'dialog');
  let ok = 0;
  for (const c of chats) {
    try {
      await members(c.chat_id, { count: 100 });
      ok += 1;
    } catch (e) {
      addLog('error', `Участники ${c.title || c.chat_id}: ${e.message.slice(0, 150)}`);
    }
  }
  return { chats: chats.length, ok };
}
