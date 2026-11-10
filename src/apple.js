// Calendar, reminders and notes for the dashboard, read straight from the signed
// macos-apps-mcp app: no Claude session, no subscription use, answers in milliseconds.
import { appleCall } from './mail.js';

const list = (out) => (Array.isArray(out) ? out : out?.results || []);

// "Тренировка 22:00–00:00" → title + time; the event start is the epoch after "|" in the id.
function parseEvent(e) {
  const m = String(e.summary || '').match(/^(.*?)\s+((?:\d{1,2}:\d{2})\s*[–-]\s*(?:\d{1,2}:\d{2})|весь день|all[- ]day)$/i);
  const start = Number(String(e.id || '').split('|')[1]) * 1000 || null;
  return { id: e.id, title: (m ? m[1] : e.summary || '').trim() || 'Без названия', time: m ? m[2].replace(/\s/g, '') : '', start, calendar: e.folder || '' };
}

export async function agenda() {
  const [week, today, overdue] = await Promise.all([
    appleCall('events', { when: 'week' }),
    appleCall('reminders', { due: 'today' }),
    appleCall('reminders', { due: 'overdue' }),
  ]);
  const events = list(week).map(parseEvent).sort((a, b) => (a.start || 0) - (b.start || 0));
  const rem = (r, kind) => ({ id: r.id, title: r.summary || '', kind, list: r.folder || '' });
  const seen = new Set();
  const reminders = [...list(overdue).map((r) => rem(r, 'overdue')), ...list(today).map((r) => rem(r, 'today'))]
    .filter((r) => !seen.has(r.id) && seen.add(r.id));
  return { events, reminders };
}

export async function upcomingReminders() {
  return list(await appleCall('reminders', {})).map((r) => ({ id: r.id, title: r.summary || '', list: r.folder || '' }));
}

export const completeReminder = (id) => appleCall('complete_reminder', { id });
export const createReminder = ({ title, due }) => appleCall('create_reminder', { title, ...(due ? { due } : {}) });
export const createEvent = ({ title, start, end, location }) => appleCall('create_event', { title, start, end, ...(location ? { location } : {}) });

// The list shows the start of a note, which can be a password line: mask anything that
// looks like a secret. The full text is shown only when the note is opened.
const maskSecrets = (t) => t
  .replace(/((?:парол\w*|password|pass|token|токен|ключ|key|secret)\s*[:=]?\s*)\S+/gi, '$1••••')
  .replace(/(\S+@\S+\s*\/\s*)\S+/g, '$1••••')
  .replace(/\b(?=[A-Za-z0-9_-]{12,}\b)(?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b/g, '••••');

export async function notesList(q = '') {
  const out = q ? await appleCall('notes', { title: q }) : await appleCall('notes_all', {});
  return list(out).map((n) => {
    const text = String(n.summary || '').trim();
    return { id: n.id, title: maskSecrets(text.split('\n')[0].slice(0, 120)) || 'Без названия', folder: n.folder || '' };
  });
}

export async function noteBody(id) {
  const out = list(await appleCall('note_bodies', { ids: [id] }));
  return { id, body: out[0]?.body || '' };
}

export const createNote = ({ title, body }) => appleCall('create_note', { title, body: body || '' });
