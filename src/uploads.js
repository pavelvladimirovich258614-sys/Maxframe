// Screenshots and files sent to the mainframe: saved under data/uploads, then the session
// gets their paths (Claude Code reads images and PDFs with its Read tool).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const safe = (name) => String(name || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-80) || 'file';

export function saveUpload(name, buffer) {
  const file = path.join(UPLOAD_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe(name)}`);
  fs.writeFileSync(file, buffer);
  // Keep the folder small: files older than 30 days go.
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 30 * 86400000) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  return file;
}

export function withAttachments(text, files) {
  if (!files.length) return text;
  const list = files.map((f) => `- ${f}`).join('\n');
  return `${(text || '').trim() || 'Посмотри вложение.'}\n\nВложения (открой через Read, это скриншоты или файлы от владельца):\n${list}`;
}
