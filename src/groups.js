// Work groups and channels → inbox.
//
// MAX delivers every message of a chat the bot is in, so the live path is
// handleMaxMessage in the dispatcher. This module is the safety net: it polls
// the chats the owner marked as work chats and turns the messages that arrived
// while the mainframe was down into one card.
//
// Only chats the bot is in can be polled: MAX gives no access to anything else.

import { config } from './config.js';
import { kvGet, kvSet, addLog } from './db.js';
import { knownChats, getMessagesAfter, listMessages, maxState } from './max-chats.js';

export const DEFAULT_GROUPS = [];

// The chats to watch: the owner's own list plus the chats named in MAX_ALLOWED_CHATS.
export function watchedGroups() {
  const own = kvGet('watch_groups', DEFAULT_GROUPS) || [];
  const byId = new Map(own.map((g) => [String(g.id ?? g.chat_id), { ...g }]));
  for (const chat of knownChats()) {
    if (chat.type !== 'chat' && chat.type !== 'channel') continue;
    const id = String(chat.chat_id);
    if (byId.has(id)) continue;
    if (!config.max.allowedChats.includes(id)) continue;
    byId.set(id, { id, title: chat.title || id, mode: 'all' });
  }
  return [...byId.values()];
}

let timer = null;
let busy = false;

export function watchGroups(onBatch, everyMs = 60000) {
  const tick = async () => {
    if (busy || !maxState.connected) return;
    busy = true;
    try {
      const last = kvGet('groups_last', {});
      for (const g of watchedGroups()) {
        const key = String(g.id);
        let msgs;
        // The cursor of the API is a timestamp: GET /messages takes `after` as
        // "messages after timestamp". The cursor of the old platform was an id
        // of a message, so a value that is not a plausible timestamp is dropped.
        const cur = Number(last[key]) >= 1e9 ? Number(last[key]) : 0;
        try {
          msgs = cur
            ? await getMessagesAfter(key, cur, 50)
            : await listMessages(key, { count: 1 });
        } catch (e) {
          addLog('error', `Группа ${g.title}: ${e.message.slice(0, 150)}`);
          continue;
        }
        if (!msgs.length) continue;
        const newest = msgs[msgs.length - 1].timestamp || 0;
        // First look at a group: start from now, not from its history.
        if (!cur) { last[key] = newest; kvSet('groups_last', last); continue; }
        last[key] = newest;
        kvSet('groups_last', last);
        const keep = msgs.filter((m) => (m.text || '') && !(g.skip || []).includes(m.senderName));
        if (!keep.length) continue;
        await onBatch({
          group: { id: key, title: g.title || key },
          messages: keep.map((m) => ({ id: m.id, sender: m.senderName || 'Без имени', username: m.senderUsername || null, text: m.text, date: m.timestamp })),
        });
      }
    } catch (e) {
      addLog('error', `Группы: ${e.message.slice(0, 200)}`);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 15000);
  timer = setInterval(tick, everyMs);
  timer.unref();
}

export const stopGroups = () => clearInterval(timer);
