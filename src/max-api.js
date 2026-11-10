// MAX Bot API client.
// Docs: https://dev.max.ru/docs-api
//
// Facts this client relies on (checked 2026-11):
//  * base URL https://platform-api2.max.ru, the raw bot token in `Authorization` (no Bearer);
//  * `chat_id` on POST /messages is a QUERY parameter, the recipient is never in the body;
//  * there is no GET /chats list endpoint anymore (June 2026) - the chats the bot is in
//    come from POST /subscriptions or from incoming events;
//  * `disable_link_preview` is a query parameter on POST /messages and POST /answers only;
//  * message text is capped at 4000 characters.

const DEFAULT_BASE_URL = 'https://platform-api2.max.ru';
const TEXT_LIMIT = 4000;

export class MaxApiError extends Error {
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.name = 'MaxApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MaxApi {
  constructor({ token, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, minIntervalMs = 40 } = {}) {
    if (!token) throw new Error('MAX_BOT_TOKEN is required');
    this.token = token;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    // The platform allows 30 requests per second. A small gap keeps a burst of
    // answers below that without a full rate limiter.
    this.minIntervalMs = minIntervalMs;
    this.lastRequest = 0;
  }

  async throttle() {
    const wait = this.lastRequest + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequest = Date.now();
  }

  async request(method, pathname, { query = {}, body, signal, raw } = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    await this.throttle();
    const response = await this.fetch(url, {
      method,
      signal,
      headers: {
        Authorization: this.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      // The token never appears in the message: only the server's own text does.
      const message = parsed?.message || parsed?.error?.message || 'без описания';
      throw new MaxApiError(`MAX ${method} ${pathname}: HTTP ${response.status} · ${message}`, {
        status: response.status,
        code: parsed?.code || parsed?.error?.code || null,
        body: parsed,
      });
    }
    if (raw) return { text, json: parsed };
    return parsed;
  }

  // ---- bot ---------------------------------------------------------------
  getMe(signal) {
    return this.request('GET', '/me', { signal });
  }

  // Commands of the bot menu. MAX takes a plain array here.
  setCommands(commands, signal) {
    return this.request('PATCH', '/me/commands', { body: commands, signal });
  }

  // ---- messages ----------------------------------------------------------
  // chatId and disableLinkPreview are query parameters; text/format/link are the body.
  sendMessage(chatId, text, { format, replyTo, forwardTo, attachments, notify, disableLinkPreview, signal } = {}) {
    if (chatId === undefined || chatId === null || chatId === '') throw new Error('chatId is required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text must not be empty');
    if (text.length > TEXT_LIMIT) throw new Error(`text must not exceed ${TEXT_LIMIT} characters`);
    const body = { text };
    if (format) body.format = format;
    if (replyTo) body.link = { type: 'reply', mid: String(replyTo) };
    else if (forwardTo) body.link = { type: 'forward', mid: String(forwardTo) };
    if (attachments) body.attachments = attachments;
    if (notify !== undefined) body.notify = Boolean(notify);
    return this.request('POST', '/messages', {
      query: { chat_id: chatId, disable_link_preview: disableLinkPreview ? 'true' : undefined },
      body,
      signal,
    });
  }

  editMessage(messageId, { text, format, attachments, signal } = {}) {
    if (!messageId) throw new Error('messageId is required');
    const body = {};
    if (text !== undefined) body.text = text;
    if (format) body.format = format;
    if (attachments !== undefined) body.attachments = attachments;
    return this.request('PUT', '/messages', { query: { message_id: messageId }, body, signal });
  }

  deleteMessage(messageId, signal) {
    if (!messageId) throw new Error('messageId is required');
    return this.request('DELETE', '/messages', { query: { message_id: messageId }, signal });
  }

  // Messages of a chat, newest first. `after`/`before` are message ids.
  getMessages(chatId, { count, after, before, messageIds, signal } = {}) {
    if (chatId === undefined || chatId === null || chatId === '') throw new Error('chatId is required');
    return this.request('GET', '/messages', {
      query: {
        chat_id: chatId,
        count,
        after,
        before,
        message_ids: Array.isArray(messageIds) ? messageIds.join(',') : messageIds,
      },
      signal,
    });
  }

  // ---- chats and members -------------------------------------------------
  getChat(chatId, signal) {
    return this.request('GET', `/chats/${encodeURIComponent(String(chatId))}`, { signal });
  }

  // Bot's own membership: what it may do in this chat (permissions, admin flags).
  getMemberMe(chatId, signal) {
    return this.request('GET', `/chats/${encodeURIComponent(String(chatId))}/members/me`, { signal });
  }

  getMembers(chatId, { count, marker, userIds, signal } = {}) {
    if (chatId === undefined || chatId === null || chatId === '') throw new Error('chatId is required');
    return this.request('GET', `/chats/${encodeURIComponent(String(chatId))}/members`, {
      query: {
        count,
        marker,
        user_ids: Array.isArray(userIds) ? userIds.join(',') : userIds,
      },
      signal,
    });
  }

  getAdmins(chatId, signal) {
    return this.request('GET', `/chats/${encodeURIComponent(String(chatId))}/members/admins`, { signal });
  }

  // Typing indicator and similar chat actions.
  sendAction(chatId, action, signal) {
    return this.request('POST', `/chats/${encodeURIComponent(String(chatId))}/actions`, {
      body: { type: action },
      signal,
    });
  }

  // ---- updates: webhook subscriptions and long polling --------------------
  listSubscriptions(signal) {
    return this.request('GET', '/subscriptions', { signal });
  }

  subscribe({ url, secret, updateTypes, signal } = {}) {
    if (!url) throw new Error('url is required');
    const body = { url };
    if (secret) body.secret = secret;
    if (updateTypes?.length) body.update_types = updateTypes;
    return this.request('POST', '/subscriptions', { body, signal });
  }

  unsubscribe(url, signal) {
    if (!url) throw new Error('url is required');
    return this.request('DELETE', '/subscriptions', { query: { url }, signal });
  }

  // Long polling. Development only: MAX does not allow polling and a webhook at once.
  getUpdates({ limit, timeout, marker, types, signal } = {}) {
    return this.request('GET', '/updates', {
      query: {
        limit,
        timeout,
        marker,
        types: Array.isArray(types) ? types.join(',') : types,
      },
      signal,
    });
  }

  // ---- callbacks ---------------------------------------------------------
  // Answer a button press. `notification` is a one-time toast, `message` edits the original.
  answerCallback(callbackId, { notification, message, signal } = {}) {
    if (!callbackId) throw new Error('callbackId is required');
    const body = {};
    if (notification) body.notification = notification;
    if (message) body.message = message;
    return this.request('POST', '/answers', {
      query: { callback_id: callbackId },
      body,
      signal,
    });
  }

  // ---- uploads -----------------------------------------------------------
  // Two steps: ask for an upload URL, then PUT the binary to it. The URL is
  // single-use and its host is not stable, so it is never hardcoded.
  async upload(type, buffer, { filename = 'file', contentType = 'application/octet-stream', signal } = {}) {
    if (!['image', 'video', 'audio', 'file'].includes(type)) throw new Error('type must be image, video, audio or file');
    const ticket = await this.request('POST', '/uploads', { query: { type }, signal });
    if (!ticket?.url) throw new Error('MAX did not return an upload url');
    const response = await this.fetch(ticket.url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': contentType, ...(filename ? { 'X-File-Name': encodeURIComponent(filename) } : {}) },
      body: buffer,
    });
    if (!response.ok) throw new MaxApiError(`MAX upload: HTTP ${response.status}`, { status: response.status });
    const token = ticket.token || (await response.json().catch(() => null))?.token;
    return { type, payload: token ? { token } : {} };
  }
}

// MAX chat kinds.
export const CHAT_DIALOG = 'dialog';
export const CHAT_GROUP = 'chat';
export const CHAT_CHANNEL = 'channel';

// Pull the plain text out of a MAX message body.
export const messageText = (message) => {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const body = message.body || message;
  const text = typeof body.text === 'string' ? body.text : '';
  if (text) return text;
  const attachments = body.attachments || [];
  const parts = [];
  for (const a of attachments) {
    if (a.type === 'image') parts.push('[фото]');
    else if (a.type === 'video') parts.push('[видео]');
    else if (a.type === 'audio') parts.push('[голосовое]');
    else if (a.type === 'file') parts.push(`[файл ${a.filename || ''}]`.trim());
    else if (a.type === 'sticker') parts.push('[стикер]');
    else if (a.type === 'contact') parts.push('[контакт]');
    else if (a.type === 'location') parts.push('[геометка]');
  }
  return parts.join(' ');
};

// The id of a message: `body.mid` is the canonical one.
export const messageId = (message) => {
  if (!message) return null;
  if (typeof message === 'string') return message;
  return message.body?.mid || message.mid || null;
};
