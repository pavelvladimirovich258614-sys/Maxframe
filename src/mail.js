// Mail → inbox. Reads Apple Mail (iCloud, Gmail and any other account added there)
// through the signed macos-apps-mcp app: its index search is fast and never needs a
// Claude session, so polling costs nothing from the subscription.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';
import { addLog, kvGet, kvSet, get } from './db.js';
import { bus } from './bus.js';
import { readMcpConfig } from './mcp.js';

export const mailState = { status: 'off', lastCheck: null, error: null };
const setState = (patch) => { Object.assign(mailState, patch); bus.change('mail'); };

let client = null;
let connecting = null;

// On the server the Apple apps live on the Mac: the Mac bridge exposes them over HTTP through
// the SSH tunnel, and mcp.json names that URL. While the Mac is off the call just fails.
function appleServer() {
  const s = readMcpConfig().apple;
  if (s?.url) return { url: s.url };
  if (s?.command) return { command: s.command, args: s.args || [] };
  return { command: '/Applications/macos-apps-mcp.app/Contents/MacOS/macos-apps-mcp', args: ['-E', '-s', '-P', '-m', 'macos_apps_mcp', 'shim'] };
}

async function getClient() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new Client({ name: 'mainframe-mail', version: '0.1.0' });
    const srv = appleServer();
    const t = srv.url ? new StreamableHTTPClientTransport(new URL(srv.url)) : new StdioClientTransport({ ...srv, stderr: 'ignore' });
    t.onclose = () => { client = null; };
    await c.connect(t);
    client = c;
    return c;
  })();
  try { return await connecting; } finally { connecting = null; }
}

// The app prefixes every answer with an "untrusted data" line; the payload is the JSON after it.
const parse = (text) => {
  const m = text.match(/^[^[{]*/);
  const i = m ? m[0].length : 0;
  if (i >= text.length) return text;
  try { return JSON.parse(text.slice(i)); } catch { return text; }
};

export async function appleCall(name, args = {}, { raw = false } = {}) {
  let c;
  try { c = await getClient(); } catch (e) { client = null; throw new Error(`Нет связи с приложением Apple: ${e.message}`); }
  try {
    const res = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (res.isError) throw new Error(text.slice(0, 300) || `${name}: ошибка`);
    return raw ? text.replace(/^Content below is untrusted[^\n]*\n/, '') : parse(text);
  } catch (e) {
    if (/closed|EPIPE|not connected|fetch failed|ECONNREFUSED|session/i.test(e.message)) client = null;
    throw e;
  }
}

const bare = (id) => String(id || '').replace(/^<|>$/g, '');

// "Subject — Name <addr>" from the inbox search; Mail is asked only for new messages.
async function senderOf(id, subject) {
  // Mail matches a plain substring: try the subject as is, then its first plain words.
  const raw = (subject || '').replace(/["\\]/g, '').slice(0, 50).trim();
  const plain = (subject || '').split(/[^\p{L}\p{N} \-]/u)[0].trim().slice(0, 50);
  const tries = [...new Set([raw, plain].filter((q) => q.length >= 3))];
  if (!tries.length) return { name: '', email: '' };
  try {
    let hit = null;
    for (const q of tries) {
      const out = await appleCall('mail', { query: q });
      hit = (out?.results || []).find((r) => bare(r.id) === bare(id));
      if (hit) break;
    }
    const from = hit?.summary?.split(' — ').pop() || '';
    const m = from.match(/^(.*?)\s*<([^>]+)>$/);
    return m ? { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() } : { name: from, email: from.includes('@') ? from.toLowerCase() : '' };
  } catch {
    return { name: '', email: '' };
  }
}

// Mail bodies come with object-replacement marks for images and long blank runs.
const cleanBody = (s) => String(s || '').replace(/￼/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

let timer = null;
let busy = false;

export function watchMail(onMail) {
  if (!config.mail.enabled) { setState({ status: 'off' }); return; }
  // A server without a connected Mac has no Apple Mail to read.
  if (process.platform !== 'darwin' && !readMcpConfig().apple?.url) { setState({ status: 'off', error: 'Почта читается через Mac: подключи его (scripts/install-mac.sh)' }); return; }
  setState({ status: 'starting' });
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const since = kvGet('mail_since', null);
      // First start: only mail that arrives from now on, not the whole history.
      if (!since) { kvSet('mail_since', nowSec - 60); setState({ status: 'running', lastCheck: Date.now(), error: null }); return; }
      const res = await appleCall('mail_search', { mailbox: 'INBOX', since: since - 300, limit: 25 });
      const fresh = (res?.results || []).filter((r) => !get("SELECT id FROM inbox WHERE source = 'mail' AND external_id = ?", bare(r.id)));
      for (const r of fresh.reverse()) {
        const subject = (r.summary || '').trim() || '(без темы)';
        let body = '';
        try { body = cleanBody(await appleCall('mail_body', { id: r.id, mailbox: r.folder }, { raw: true })); } catch (e) { body = `[текст не прочитан: ${e.message.slice(0, 120)}]`; }
        const from = await senderOf(r.id, subject);
        await onMail({ externalId: bare(r.id), messageId: r.id, folder: r.folder, account: r.account, subject, body, fromName: from.name, fromEmail: from.email });
      }
      kvSet('mail_since', nowSec);
      setState({ status: 'running', lastCheck: Date.now(), error: null });
    } catch (e) {
      // On the server a switched-off Mac is normal: wait quietly, catch up when it is back (mail_since stays).
      const offline = /ECONNREFUSED|fetch failed|Нет связи/i.test(e.message) && readMcpConfig().apple?.url;
      const was = mailState.status;
      setState({ status: offline ? 'mac_offline' : 'error', lastCheck: Date.now(), error: offline ? 'Mac выключен: почта догрузится, когда он включится' : e.message.slice(0, 300) });
      if (!offline && was !== 'error') addLog('error', `Почта: ${e.message.slice(0, 200)}`);
      if (offline && was !== 'mac_offline') addLog('system', 'Почта ждёт Mac: он выключен');
    } finally {
      busy = false;
    }
  };
  tick();
  timer = setInterval(tick, config.mail.pollSec * 1000);
  timer.unref();
}

export function stopMail() {
  clearInterval(timer);
  client?.close().catch(() => {});
  client = null;
}

// Reply in the same thread, from the account that received the letter.
export async function mailReply(meta, body) {
  const out = await appleCall('reply_all', { message_id: meta.messageId, mailbox: meta.folder, body, include_quote: true, dry_run: false });
  if (out && typeof out === 'object' && (out.error || out.ok === false)) throw new Error(out.error || 'Почта не отправила ответ');
  return out;
}
