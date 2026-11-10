import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const flag = (k, d = false) => {
  const v = env(k, d ? '1' : '0').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const list = (k) => env(k).split(',').map((s) => s.trim()).filter(Boolean);

export const DATA_DIR = path.resolve(ROOT, expandHome(env('DATA_DIR', 'data')));
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });

function secret(name, bytes = 18) {
  const file = path.join(DATA_DIR, `${name}.secret`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const value = crypto.randomBytes(bytes).toString('base64url');
  fs.writeFileSync(file, value, { mode: 0o600 });
  return value;
}

export const config = {
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', '7777')),
  dashboardToken: env('DASHBOARD_TOKEN') || secret('dashboard-token'),
  pairingCode: secret('pairing-code', 6),

  // ---- MAX (formerly Telegram) transport ---------------------------------
  max: {
    token: env('MAX_BOT_TOKEN'),
    apiUrl: env('MAX_API_URL', 'https://platform-api2.max.ru').replace(/\/+$/, ''),
    // The owner's MAX user id. Left empty until the bot is paired from the dashboard.
    ownerId: env('MAX_OWNER_ID'),
    // Shared with MAX: it comes back in the X-Max-Bot-Api-Secret header.
    // MAX accepts 5-256 chars from [A-Za-z0-9_-]; base64url fits that set.
    webhookSecret: env('MAX_WEBHOOK_SECRET') || secret('max-webhook-secret'),
    // Public https URL of this service, e.g. https://maxframe.example.com
    publicUrl: env('PUBLIC_URL'),
    // Production requires a webhook on port 443. Long polling is for local runs only.
    longPolling: flag('MAX_LONG_POLLING', true),
    // Chats the bot answers in. Empty = every chat the bot is in.
    allowedChats: list('MAX_ALLOWED_CHATS'),
    // Chats where the bot may post on its own (its own channel, sales bot room).
    autoChats: list('MAX_AUTO_CHATS'),
  },

  // ---- MiniMax (formerly Claude) executor --------------------------------
  minimax: {
    apiKey: env('MINIMAX_API_KEY'),
    baseUrl: env('MINIMAX_BASE_URL', 'https://api.minimax.io/v1').replace(/\/+$/, ''),
    model: env('MINIMAX_MODEL', 'MiniMax-M3.1-Flash'),
    dispatchModel: env('MINIMAX_DISPATCH_MODEL') || env('MINIMAX_MODEL', 'MiniMax-M3.1-Flash'),
    maxTokens: Number(env('MINIMAX_MAX_TOKENS', '8192')) || 8192,
    // low | medium | high | max - omitted when empty
    reasoningEffort: env('MINIMAX_REASONING_EFFORT'),
    // How many tool rounds one run may take before it is stopped.
    maxTurns: Number(env('MINIMAX_MAX_TURNS', '40')) || 40,
  },

  // bypassPermissions | ask | deny - what the executor may do without the owner.
  permissionMode: env('PERMISSION_MODE', 'bypassPermissions'),
  autoForward: flag('AUTO_FORWARD'),
  autoReply: flag('AUTO_REPLY'),

  workspaceDir: path.resolve(expandHome(env('WORKSPACE_DIR', path.join(os.homedir(), 'Assistant')))),
  kbDir: path.resolve(ROOT, expandHome(env('KB_DIR', 'kb'))),
  mcpFile: path.resolve(ROOT, expandHome(env('MCP_CONFIG', 'mcp.json'))),
};

// Server mode: projects outside SERVER_DIRS live on the owner's Mac and are
// worked on there over SSH (see src/mac-remote.js). Empty on the Mac itself:
// everything is local.
config.macRunner = env('MAC_RUNNER');
config.serverDirs = list('SERVER_DIRS');
// The Mac is reached over the same tunnel: ssh -p 2222 through the local port
// forward. Commands of a Mac project run there, not on the server.
config.mac = {
  user: env('MAC_USER'),
  sshPort: env('MAC_SSH_PORT', '2222'),
  sshKey: path.resolve(expandHome(env('MAC_SSH_KEY', '~/.ssh/to_mac'))),
};
// LinkedIn app (self-serve products): see src/linkedin.js.
config.linkedin = { clientId: env('LINKEDIN_CLIENT_ID'), clientSecret: env('LINKEDIN_CLIENT_SECRET') };
// The MAX channel shown live in the social tab (numeric chat id).
config.social = { chatId: env('SOCIAL_MAX_CHAT_ID') };
// Who the mainframe works for, and what their posts lead to. Everything personal lives here and
// in the memory folder, not in the code.
config.owner = {
  name: env('OWNER_NAME', 'владелец'),
  about: env('OWNER_ABOUT'),
  siteUrl: env('OFFER_URL').replace(/\/?$/, '/').replace(/^\/$/, ''),
  offerCta: env('OFFER_CTA', 'ссылка на мой продукт'),
  salesBot: env('SALES_BOT'),
};
// Apple Mail (all accounts added in Mail, Gmail included) into the inbox; MAIL=off disables.
config.mail = { enabled: !['off', '0', 'no', 'false'].includes(env('MAIL', 'on').toLowerCase()), pollSec: Math.max(30, Number(env('MAIL_POLL_SEC', '90')) || 90) };
// Local whisper.cpp server for voice messages; WHISPER_URL=off disables transcription.
config.whisper = {
  url: ['off', 'none', '0'].includes(env('WHISPER_URL').toLowerCase()) ? '' : env('WHISPER_URL', 'http://127.0.0.1:8178').replace(/\/+$/, ''),
  language: env('WHISPER_LANGUAGE'),
};

// The MAX transport is only usable with a token.
config.max.enabled = Boolean(config.max.token);
