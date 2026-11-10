// Expenses: bank card notifications (BIDV) are parsed without a model and kept here;
// receipts and manual entries are added by sessions (mainframe add_expense) or the dashboard.
import { all, get, run, now } from './db.js';
import { bus } from './bus.js';

run(`CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'VND',
  merchant TEXT,
  category TEXT,
  note TEXT,
  source TEXT,
  external_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
)`);

// Older databases: direction (out = расход, in = поступление).
try { run("ALTER TABLE expenses ADD COLUMN direction TEXT DEFAULT 'out'"); } catch { /* already there */ }

run(`CREATE TABLE IF NOT EXISTS balances (
  account TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  note TEXT,
  at INTEGER NOT NULL
)`);
export function setBalance({ account, amount, currency, note = '' }) {
  run('INSERT INTO balances (account, amount, currency, note, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, note = excluded.note, at = excluded.at', account, Number(amount), String(currency).toUpperCase(), note, now());
  bus.change('finance');
  return { ok: true };
}
export const listBalances = () => all('SELECT * FROM balances ORDER BY account');

import { categorize } from './finance-parse.js';
export { categorize };

// Bank and exchange mails (BIDV card, Bybit) → one expense or income record.
export { parseFinanceMail } from './finance-parse.js';
import { parseFinanceMail as parseMail } from './finance-parse.js';
export const parseBankMail = (fromEmail, text, subject = '', fallbackAt = null) => parseMail(fromEmail, subject, text, fallbackAt);

export function addExpense(e) {
  const res = run(
    'INSERT OR IGNORE INTO expenses (at, amount, currency, merchant, category, note, source, external_id, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    e.at || now(), Number(e.amount), (e.currency || 'VND').toUpperCase(), e.merchant || '', e.category || categorize(e.merchant || e.note || ''), e.note || '', e.source || 'вручную', e.external_id || null, e.direction === 'in' ? 'in' : 'out', now(),
  );
  bus.change('finance');
  return { id: Number(res.lastInsertRowid), added: res.changes > 0 };
}

export const deleteExpense = (id) => { run('DELETE FROM expenses WHERE id = ?', Number(id)); bus.change('finance'); return { ok: true }; };

export function listExpenses({ from = 0, to = Date.now() + 86400000, limit = 500 } = {}) {
  return all('SELECT * FROM expenses WHERE at >= ? AND at < ? ORDER BY at DESC LIMIT ?', from, to, limit);
}

// Totals per currency for today / 7 days / this month, and by category for the month.
export function financeSummary() {
  const d = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const sum = (from) => all("SELECT currency, SUM(amount) total, COUNT(*) n FROM expenses WHERE at >= ? AND COALESCE(direction, 'out') = 'out' GROUP BY currency", from);
  const income = (from) => all("SELECT currency, SUM(amount) total, COUNT(*) n FROM expenses WHERE at >= ? AND direction = 'in' GROUP BY currency", from);
  return {
    balances: listBalances(),
    today: sum(dayStart), week: sum(Date.now() - 7 * 86400000), month: sum(monthStart), incomeMonth: income(monthStart),
    categories: all("SELECT category, currency, SUM(amount) total, COUNT(*) n FROM expenses WHERE at >= ? AND COALESCE(direction, 'out') = 'out' GROUP BY category, currency ORDER BY total DESC", monthStart),
    items: listExpenses({ from: monthStart - 31 * 86400000, limit: 300 }),
  };
}

export const expenseCount = () => get('SELECT COUNT(*) c FROM expenses').c;

// Mails that arrived before a parser existed (or while the mainframe ran older code).
export function rescanInbox(days = 45) {
  let added = 0;
  for (const i of all("SELECT id, username, text, created_at, meta FROM inbox WHERE source = 'mail' AND created_at > ?", now() - days * 86400000)) {
    let subject = '';
    try { subject = JSON.parse(i.meta || '{}').subject || ''; } catch { /* old row */ }
    const e = parseMail(i.username, subject, i.text || '', i.created_at);
    if (e && addExpense(e).added) added++;
  }
  return added;
}

// Rubles per unit for every currency, from the Central Bank of Russia daily feed (no key).
// Stablecoins count as dollars. Cached for 6 hours; on failure the last known rates stay.
let rateCache = { at: 0, date: null, rub: { RUB: 1 } };
export async function rates() {
  if (Date.now() - rateCache.at < 6 * 3600000 && rateCache.date) return rateCache;
  try {
    const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { signal: AbortSignal.timeout(8000) });
    const d = await res.json();
    const rub = { RUB: 1 };
    for (const [code, v] of Object.entries(d.Valute || {})) rub[code] = v.Value / v.Nominal;
    rub.USDT = rub.USDC = rub.USD;
    rateCache = { at: Date.now(), date: d.Date, rub };
  } catch { /* keep the last rates */ }
  return rateCache;
}
