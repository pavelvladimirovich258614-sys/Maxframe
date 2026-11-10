// LinkedIn, the official self-serve way: "Sign In with LinkedIn using OpenID Connect" +
// "Share on LinkedIn" (w_member_social). One login on the Mac (localhost callback), a
// 60-day token, posts as the owner. Reading messages is not offered by LinkedIn to anyone:
// those come into the inbox from LinkedIn's notification e-mails (dispatcher).
import crypto from 'node:crypto';
import { config } from './config.js';
import { kvGet, kvSet, addLog } from './db.js';
import { bus } from './bus.js';

const SCOPES = 'openid profile email w_member_social';
// On the server the callback comes to the public https address (it must be listed in the LinkedIn app).
export const redirectUri = () => (config.publicUrl?.startsWith('https://') && !process.env.LINKEDIN_LOCAL_CALLBACK ? `${config.publicUrl}/oauth/linkedin/callback` : `http://localhost:${config.port}/oauth/linkedin/callback`);
export const configured = () => Boolean(config.linkedin.clientId && config.linkedin.clientSecret);

export function status() {
  const a = kvGet('linkedin_auth', null);
  if (!configured()) return { state: 'not_configured' };
  if (!a?.token) return { state: 'not_connected' };
  const daysLeft = Math.floor((a.expires_at - Date.now()) / 86400000);
  return { state: daysLeft < 0 ? 'expired' : 'connected', name: a.name, picture: a.picture, email: a.email, expires_at: a.expires_at, daysLeft };
}

export const posts = () => kvGet('linkedin_posts', []);

export function authUrl() {
  const state = crypto.randomBytes(12).toString('hex');
  kvSet('linkedin_state', { state, at: Date.now() });
  const q = new URLSearchParams({ response_type: 'code', client_id: config.linkedin.clientId, redirect_uri: redirectUri(), scope: SCOPES, state });
  return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
}

export async function handleCallback(code, state) {
  const saved = kvGet('linkedin_state', null);
  if (!saved || saved.state !== state || Date.now() - saved.at > 15 * 60000) throw new Error('Ссылка входа устарела, начни заново');
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: config.linkedin.clientId, client_secret: config.linkedin.clientSecret }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.access_token) throw new Error(tok.error_description || tok.error || `LinkedIn ответил ${res.status}`);
  const me = await (await fetch('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  kvSet('linkedin_auth', { token: tok.access_token, expires_at: Date.now() + (tok.expires_in || 5184000) * 1000, sub: me.sub, name: me.name, email: me.email, picture: me.picture, scope: tok.scope });
  kvSet('linkedin_state', null);
  addLog('system', `LinkedIn подключён: ${me.name}`);
  bus.change('linkedin');
  return me;
}

// A text post (optionally with a link card) on the owner's profile.
export async function post({ text, link }) {
  const a = kvGet('linkedin_auth', null);
  if (!a?.token) throw new Error('LinkedIn не подключён: «Система» → «Подключить LinkedIn» на Mac');
  if (a.expires_at < Date.now()) throw new Error('Доступ к LinkedIn истёк, переподключи его в «Системе»');
  const content = link
    ? { shareCommentary: { text }, shareMediaCategory: 'ARTICLE', media: [{ status: 'READY', originalUrl: link }] }
    : { shareCommentary: { text }, shareMediaCategory: 'NONE' };
  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
    body: JSON.stringify({
      author: `urn:li:person:${a.sub}`,
      lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': content },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LinkedIn не опубликовал (${res.status}): ${body.slice(0, 200)}`);
  const id = res.headers.get('x-restli-id') || (() => { try { return JSON.parse(body).id; } catch { return null; } })();
  addLog('system', `LinkedIn: опубликован пост ${id || ''}`);
  const list = kvGet('linkedin_posts', []);
  list.unshift({ id, text, link: link || null, url: id ? `https://www.linkedin.com/feed/update/${id}/` : null, at: Date.now() });
  kvSet('linkedin_posts', list.slice(0, 50));
  bus.change('linkedin');
  return { id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : null };
}

// A week before the token runs out, ask the owner to reconnect (once a day at most).
export function watchExpiry(notify) {
  const check = () => {
    const s = status();
    if (s.state === 'connected' && s.daysLeft <= 7 && kvGet('linkedin_warned', '') !== new Date().toDateString()) {
      kvSet('linkedin_warned', new Date().toDateString());
      notify(`🔗 Доступ к LinkedIn закончится через ${s.daysLeft} дн. Переподключи: открой пульт по личной ссылке в браузере → «Система» → «Подключить LinkedIn».`);
    }
  };
  setTimeout(check, 60000);
  setInterval(check, 6 * 3600000).unref();
}
