// Recall: full-text search over everything the mainframe has seen, so a session can answer
// «что Аня писала про договор» или «что решили про цену в октябре» with dates and sources.
// SQLite FTS5 in the main database: no extra service, no model calls, no subscription use.
// Indexed: session runs (the owner's request + the answer), inbox (MAX, mail, work groups),
// MAX chats day by day (people and the chats the bot is in, the owner's messages included)
// and the shared memory notes.
import { config } from './config.js';
import { all, get, run, kvGet, kvSet, addLog, db, rebuildTable } from './db.js';
import { knownChats, listMessages, getMessagesAfter } from './max-chats.js';
import { listMemory, MEMORY_DIR } from './memory.js';

run(`CREATE TABLE IF NOT EXISTS recall_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, chat TEXT, who TEXT,
  at INTEGER, title TEXT, body TEXT NOT NULL)`);
run(`CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(title, body, who, content='recall_docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2')`);
run(`CREATE TRIGGER IF NOT EXISTS recall_ai AFTER INSERT ON recall_docs BEGIN
  INSERT INTO recall_fts(rowid, title, body, who) VALUES (new.id, new.title, new.body, new.who); END`);
run(`CREATE TRIGGER IF NOT EXISTS recall_ad AFTER DELETE ON recall_docs BEGIN
  INSERT INTO recall_fts(recall_fts, rowid, title, body, who) VALUES ('delete', old.id, old.title, old.body, old.who); END`);
run(`CREATE TRIGGER IF NOT EXISTS recall_au AFTER UPDATE ON recall_docs BEGIN
  INSERT INTO recall_fts(recall_fts, rowid, title, body, who) VALUES ('delete', old.id, old.title, old.body, old.who);
  INSERT INTO recall_fts(rowid, title, body, who) VALUES (new.id, new.title, new.body, new.who); END`);
// Raw messages of the chats: the day documents are rebuilt from here when new messages arrive.
// The name of the table and its columns are left as they were in the Telegram days on purpose:
// the data accumulated there must not be lost, only its source changed (now it is MAX).
// The same reason keeps the old ref prefix of the day documents, so the old days are updated
// instead of being duplicated.
// The id of a message in MAX is a string, in Telegram it was a number. The
// column held the id of the message, and with the id of MAX the index kept
// only one message per chat (the id became 0 for every message). The table is
// rebuilt with TEXT; the old rows keep their ids as text.
run(`CREATE TABLE IF NOT EXISTS recall_tg (chat TEXT NOT NULL, msg_id TEXT NOT NULL, at INTEGER, who TEXT, text TEXT, PRIMARY KEY (chat, msg_id))`);
const msgIdCol = db.prepare('PRAGMA table_info(recall_tg)').all().find((c) => c.name === 'msg_id');
if (msgIdCol && String(msgIdCol.type).toUpperCase() !== 'TEXT') {
  rebuildTable('recall_tg', `
    CREATE TABLE recall_tg_new (
      chat TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      at INTEGER,
      who TEXT,
      text TEXT,
      PRIMARY KEY (chat, msg_id)
    );`, `
    INSERT OR IGNORE INTO recall_tg_new (chat, msg_id, at, who, text)
      SELECT chat, CAST(msg_id AS TEXT), at, who, text FROM recall_tg;`);
}

export const KINDS = { session: 'сессии мейнфрейма', max: 'MAX', mail: 'почта', group: 'рабочие группы', memory: 'память', chat: 'переписка в MAX' };

function upsert({ ref, kind, chat = null, who = null, at, title = '', body }) {
  if (!String(body || '').trim()) return;
  run(`INSERT INTO recall_docs (ref, kind, chat, who, at, title, body) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, chat = excluded.chat, who = excluded.who, at = excluded.at, title = excluded.title, body = excluded.body`,
  ref, kind, chat, who, at || null, String(title || '').slice(0, 300), String(body).slice(0, 60000));
}

const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------- indexers ----------
function indexRuns() {
  const last = kvGet('recall_run_last', 0);
  const rows = all(`SELECT r.id, r.prompt, r.result, r.origin, r.started_at, p.name FROM runs r JOIN projects p ON p.id = r.project_id
    WHERE r.id > ? AND r.status IN ('done', 'error', 'stopped') ORDER BY r.id LIMIT 500`, last);
  for (const r of rows) {
    upsert({ ref: `run:${r.id}`, kind: 'session', chat: r.name, who: r.origin === 'cron' ? 'расписание' : config.owner.name, at: r.started_at, title: `Сессия «${r.name}»`,
      body: `Запрос: ${String(r.prompt || '').slice(0, 6000)}\n\nОтвет: ${String(r.result || '').slice(0, 12000)}` });
  }
  if (rows.length) kvSet('recall_run_last', rows[rows.length - 1].id);
  // Runs still in progress get picked up next time: the cursor only passes finished ones.
  return rows.length;
}

function indexInbox() {
  const last = kvGet('recall_inbox_last', 0);
  const rows = all('SELECT id, source, chat_id, name, text, meta, created_at FROM inbox WHERE id > ? ORDER BY id LIMIT 1000', last);
  for (const r of rows) {
    let meta = {}; try { meta = JSON.parse(r.meta || '{}'); } catch { /* old rows */ }
    upsert({ ref: `inbox:${r.id}`, kind: r.source === 'mail' ? 'mail' : r.source === 'group' ? 'group' : 'max', chat: meta.title || r.name, who: r.name, at: r.created_at,
      title: meta.subject || meta.title || r.name, body: r.text });
  }
  if (rows.length) kvSet('recall_inbox_last', rows[rows.length - 1].id);
  return rows.length;
}

function indexMemory() {
  let n = 0;
  const seen = new Set();
  for (const m of listMemory()) {
    seen.add(`mem:${m.file}`);
    upsert({ ref: `mem:${m.file}`, kind: 'memory', chat: m.type, who: 'память', at: Date.parse(m.updated) || Date.now(), title: m.title, body: `${m.description}\n${m.body}` });
    n++;
  }
  for (const d of all("SELECT ref FROM recall_docs WHERE kind = 'memory'")) if (!seen.has(d.ref)) run('DELETE FROM recall_docs WHERE ref = ?', d.ref);
  return n;
}

// ---------- MAX: the chats the bot is in ----------
// The set of chats comes from the registry of max-chats: everything the bot was added to
// (incoming events and the chats the owner named). MAX has no endpoint with all the chats,
// so this is the only complete list available.
function maxChatList() {
  const list = knownChats()
    .filter((c) => c.chat_id)
    .map((c) => ({ id: String(c.chat_id), title: c.title || (c.type === 'dialog' ? 'личный чат' : String(c.chat_id)) }));
  // The cached list is written only when it really changed, so the tab is not redrawn every tick.
  const cached = kvGet('recall_tg_chats', null);
  if (!cached || JSON.stringify(cached.list) !== JSON.stringify(list)) kvSet('recall_tg_chats', { at: Date.now(), list });
  return list;
}

// The id of a message in MAX is a string.
const midOf = (m) => (m?.id === undefined || m?.id === null ? '' : String(m.id));
// The cursor of the API is a timestamp, not an id: GET /messages takes `after`
// as "messages after timestamp". The cursor of the old platform was an id, so
// a value that is not a plausible timestamp is dropped and the chat is read
// from the beginning again.
const tsOf = (m) => Number(m.timestamp) || 0;
const maxTs = (msgs) => Math.max(0, ...msgs.map(tsOf));
const isTimestamp = (v) => Number(v) >= 1e9;
// Who wrote it: the owner's own messages are marked with the owner's name.
const whoOf = (m) => (m.senderId && m.senderId === config.max.ownerId ? config.owner.name : (m.senderName || m.senderUsername || 'без имени'));

let maxBusy = false;
export async function indexMax(maxChatsPerTick = 8) {
  if (maxBusy || !config.max.enabled) return 0;
  maxBusy = true;
  let added = 0;
  try {
    const chats = maxChatList();
    if (!chats.length) return 0;
    const cursor = kvGet('recall_tg_last', {});
    // Round-robin: a few chats per tick, so a big backfill never floods the API.
    let pos = kvGet('recall_tg_pos', 0);
    for (let i = 0; i < Math.min(maxChatsPerTick, chats.length); i++, pos++) {
      const c = chats[pos % chats.length];
      const key = String(c.id);
      // The cursor is stored under max:<chat_id>: the values of the old platform cannot be
      // read as MAX cursors, the message id spaces of the two are different.
      const ck = `max:${key}`;
      let msgs;
      const cur = isTimestamp(cursor[ck]) ? Number(cursor[ck]) : 0;
      try {
        msgs = cur
          ? await getMessagesAfter(key, cur, 100)
          : await listMessages(key, { count: 100 });
      } catch (e) { addLog('error', `Поиск по истории: ${c.title}: ${e.message.slice(0, 120)}`); continue; }
      const fresh = msgs.filter((m) => m.id && m.text);
      if (!fresh.length) { if (!cur && msgs.length) cursor[ck] = maxTs(msgs); continue; }
      const days = new Set();
      for (const m of fresh) {
        const at = (m.timestamp ? m.timestamp * 1000 : 0) || Date.now();
        const mid = midOf(m);
        run('INSERT OR IGNORE INTO recall_tg (chat, msg_id, at, who, text) VALUES (?, ?, ?, ?, ?)', key, mid || m.id, at, whoOf(m), String(m.text).slice(0, 4000));
        days.add(dayOf(at));
      }
      for (const d of days) {
        const from = new Date(`${d}T00:00:00`).getTime();
        const rows = all('SELECT at, who, text FROM recall_tg WHERE chat = ? AND at >= ? AND at < ? ORDER BY at', key, from, from + 86400000);
        upsert({ ref: `tg:${key}:${d}`, kind: 'chat', chat: c.title, who: [...new Set(rows.map((r) => r.who))].join(', '), at: rows[0]?.at || from, title: `Переписка: ${c.title}, ${d}`,
          body: rows.map((r) => `${new Date(r.at).toTimeString().slice(0, 5)} ${r.who}: ${r.text}`).join('\n') });
      }
      cursor[ck] = Math.max(cur, maxTs(fresh));
      added += fresh.length;
    }
    kvSet('recall_tg_last', cursor);
    kvSet('recall_tg_pos', pos % Math.max(1, chats.length));
  } catch (e) {
    addLog('error', `Поиск по истории: ${e.message.slice(0, 150)}`);
  } finally {
    maxBusy = false;
  }
  return added;
}

export function startRecall() {
  const tick = async () => {
    try { indexRuns(); indexInbox(); indexMemory(); } catch (e) { addLog('error', `Поиск по истории: ${e.message.slice(0, 150)}`); }
    await indexMax();
  };
  setTimeout(tick, 30000);
  setInterval(tick, 3 * 60000).unref();
}

// ---------- search ----------
// Russian words change their endings: search by the stem (word minus a short ending) as a prefix.
function ftsQuery(q, joiner = ' ') {
  const words = String(q).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) || [];
  const terms = words.filter((w) => w.length > 1).slice(0, 12).map((w) => {
    const stem = w.length >= 6 ? w.slice(0, w.length - 2) : w.length >= 5 ? w.slice(0, w.length - 1) : w;
    return `"${stem.replace(/"/g, '')}"*`;
  });
  return terms.join(joiner);
}

export function recall({ query, kind = null, days = null, limit = 8 } = {}) {
  if (!String(query || '').trim()) throw new Error('Пустой запрос');
  const lim = Math.max(1, Math.min(30, Number(limit) || 8));
  const where = []; const args = [];
  if (kind && KINDS[kind]) { where.push('d.kind = ?'); args.push(kind); }
  if (days) { where.push('d.at > ?'); args.push(Date.now() - Number(days) * 86400000); }
  const sql = (q) => `SELECT d.ref, d.kind, d.chat, d.who, d.at, d.title, snippet(recall_fts, 1, '«', '»', '…', 28) AS snip, bm25(recall_fts, 3.0, 1.0, 2.0) AS score
    FROM recall_fts JOIN recall_docs d ON d.id = recall_fts.rowid WHERE recall_fts MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
    ORDER BY score LIMIT ${lim}`;
  let rows = [];
  const strict = ftsQuery(query);
  if (strict) rows = all(sql(strict), strict, ...args);
  // Nothing with every word: fall back to any of them.
  if (!rows.length) { const loose = ftsQuery(query, ' OR '); if (loose) rows = all(sql(loose), loose, ...args); }
  return rows.map((r) => ({ ...r, kindName: KINDS[r.kind] || r.kind }));
}

export function recallOpen(ref) {
  const d = get('SELECT * FROM recall_docs WHERE ref = ?', ref);
  if (!d) throw new Error('Не нашёл такой записи');
  return d;
}

export function recallStats() {
  const byKind = all('SELECT kind, COUNT(*) AS n FROM recall_docs GROUP BY kind');
  // The names of the counters are left as they were: the tab and the API use them.
  return { total: byKind.reduce((s, r) => s + r.n, 0), byKind, tgMessages: get('SELECT COUNT(*) AS n FROM recall_tg').n, tgChats: (kvGet('recall_tg_chats', null)?.list || []).length };
}

export const formatRecall = (rows) => rows.map((r) => `[${dayOf(r.at || 0)} · ${r.kindName}${r.chat ? ` · ${r.chat}` : ''}] ${r.title}\n${r.snip}\n(ref: ${r.ref})`).join('\n\n') || 'Ничего не нашлось';
export { MEMORY_DIR };
