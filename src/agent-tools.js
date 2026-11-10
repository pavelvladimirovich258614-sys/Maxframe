// Local tools of the executor: files, search and shell.
//
// The Claude Agent SDK provided these out of the box. With MiniMax the tools
// are ordinary function calls, so they live here with one contract:
//   { name, description, parameters (JSON Schema), handler(args) -> string, dangerous? }
//
// Two rules are enforced at the boundary, where the data enters:
//  * a tool with a `root` never reads or writes outside that folder;
//  * secret-looking paths (.env, *.pem, ~/.ssh, the database) are never read.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SECRET_RE = /(^|\/)(\.env[^/]*|.*\.secret|.*\.pem|.*\.key|id_[a-z0-9]+|\.ssh|\.aws|\.gnupg|\.git|node_modules|vendor|mainframe\.db[^/]*|Library|Keychains?)(\/|$)/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build']);

const isSecret = (p) => SECRET_RE.test(String(p || '').replace(/\\/g, '/'));

// Resolve a path against the working folder and check it against the root.
// With a root, relative paths are taken from the root: that folder is the
// boundary of the tool, not the folder it was started from.
function resolvePath(anchor, root, target) {
  const raw = String(target ?? '.');
  const abs = path.resolve(anchor, raw.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (root) {
    const rel = path.relative(path.resolve(root), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Вне рабочей папки: ${raw}`);
  }
  const relToRoot = path.relative(path.resolve(root || anchor), abs);
  if (isSecret(relToRoot) || isSecret(abs)) {
    throw new Error(`Секретные файлы читать нельзя: ${raw}`);
  }
  return abs;
}

const text = (s) => String(s ?? '');

async function walk(dir, { maxFiles = 2000, out = [] } = {}) {
  if (out.length >= maxFiles) return out;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (isSecret(full)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, { maxFiles, out });
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// A small glob: * within one segment, ** across segments.
const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, (c) => `\\${c}`);

function globToRe(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRe(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

export function localTools({ cwd, root = null, allowShell = true, remote = null } = {}) {
  // With a root the tools work inside that folder; without it, in the cwd.
  const base = path.resolve(root || cwd || process.cwd());
  // A Mac project lives on the owner's computer: the files and the commands
  // are reached over SSH instead of the local disk.
  const isRemote = Boolean(remote);

  const readFile = {
    name: 'read_file',
    description: 'Прочитать текстовый файл. Возвращает содержимое с номерами строк.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу, абсолютный или относительно рабочей папки' },
        offset: { type: 'integer', description: 'С какой строки начать (с 1)' },
        limit: { type: 'integer', description: 'Сколько строк прочитать' },
      },
      required: ['path'],
    },
    handler: async ({ path: p, offset, limit }) => {
      const abs = resolvePath(base, root, p);
      if (isRemote) {
        const content = await remote.read(abs);
        const lines = content.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        const from = Math.max(1, Number(offset) || 1);
        const count = Math.max(1, Math.min(Number(limit) || 2000, lines.length));
        return lines.slice(from - 1, from - 1 + count).map((l, i) => `${from + i}\t${l}`).join('\n');
      }
      const stat = await fs.promises.stat(abs).catch(() => null);
      if (!stat) throw new Error(`Файл не найден: ${p}`);
      if (stat.size > 4 * 1024 * 1024) throw new Error('Файл слишком большой');
      const content = await fs.promises.readFile(abs, 'utf8');
      const lines = content.split('\n');
      // A file that ends with a newline has no extra empty line.
      if (lines[lines.length - 1] === '') lines.pop();
      const from = Math.max(1, Number(offset) || 1);
      const count = Math.max(1, Math.min(Number(limit) || 2000, lines.length));
      const slice = lines.slice(from - 1, from - 1 + count);
      return slice.map((l, i) => `${from + i}\t${l}`).join('\n');
    },
  };

  const writeFile = {
    name: 'write_file',
    description: 'Создать файл или перезаписать его целиком. Для правки части файла используй edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу' },
        content: { type: 'string', description: 'Новое содержимое файла' },
      },
      required: ['path', 'content'],
    },
    handler: async ({ path: p, content }) => {
      const abs = resolvePath(base, root, p);
      if (isRemote) return remote.write(abs, text(content));
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, text(content), 'utf8');
      return `Записано: ${p}`;
    },
  };

  const editFile = {
    name: 'edit_file',
    description: 'Заменить точный фрагмент в файле. old_string должен встречаться в файле (уникально, если replace_all не указан).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу' },
        old_string: { type: 'string', description: 'Что заменить' },
        new_string: { type: 'string', description: 'На что заменить' },
        replace_all: { type: 'boolean', description: 'Заменить все вхождения' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    handler: async ({ path: p, old_string, new_string, replace_all }) => {
      const abs = resolvePath(base, root, p);
      const content = isRemote ? await remote.read(abs) : await fs.promises.readFile(abs, 'utf8');
      const needle = text(old_string);
      if (!needle) throw new Error('old_string пустой');
      const count = content.split(needle).length - 1;
      if (!count) throw new Error(`Фрагмент не найден в ${p}`);
      if (count > 1 && !replace_all) throw new Error(`Фрагмент встречается ${count} раза: уточни или укажи replace_all`);
      const next = replace_all ? content.split(needle).join(text(new_string)) : content.replace(needle, text(new_string));
      if (isRemote) return remote.write(abs, next);
      await fs.promises.writeFile(abs, next, 'utf8');
      return `Изменено: ${p} (${replace_all ? count : 1} вхожд.)`;
    },
  };

  const listFiles = {
    name: 'list_files',
    description: 'Список файлов в папке (рекурсивно). pattern — маска, например "**/*.md".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Папка, по умолчанию рабочая' },
        pattern: { type: 'string', description: 'Маска файла' },
      },
      required: [],
    },
    handler: async ({ path: p, pattern }) => {
      const dir = resolvePath(base, root, p || '.');
      if (isRemote) {
        const cmd = `find ${JSON.stringify(dir)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -name '.*' 2>/dev/null | head -500`;
        const out = await remote.exec(cmd, { cwd: base });
        const lines = out.split('\n').filter((l) => l && !l.startsWith('['));
        if (!lines.length) return 'Ничего не найдено';
        return lines.map((l) => l.replace(base, '').replace(/^[\\/]/, '')).join('\n');
      }
      const files = await walk(dir);
      const re = pattern ? globToRe(pattern) : null;
      const picked = re ? files.filter((f) => re.test(path.relative(dir, f).replace(/\\/g, '/'))) : files;
      if (!picked.length) return 'Ничего не найдено';
      return picked.slice(0, 500).map((f) => path.relative(base, f).replace(/\\/g, '/')).join('\n');
    },
  };

  const searchFiles = {
    name: 'search_files',
    description: 'Найти строки по регулярному выражению в файлах папки. Возвращает файл, номер строки и саму строку.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Регулярное выражение' },
        path: { type: 'string', description: 'Папка для поиска, по умолчанию рабочая' },
        glob: { type: 'string', description: 'Ограничить тип файлов, например "**/*.md"' },
      },
      required: ['pattern'],
    },
    handler: async ({ pattern, path: p, glob }) => {
      const dir = resolvePath(base, root, p || '.');
      if (isRemote) {
        const include = glob ? `--include=${JSON.stringify(glob.replace(/^\*\*\//, ''))}` : '';
        const cmd = `grep -rniE ${JSON.stringify(pattern)} ${JSON.stringify(dir)} ${include} 2>/dev/null | head -200`;
        const out = await remote.exec(cmd, { cwd: base });
        const lines = out.split('\n').filter((l) => l && !l.startsWith('['));
        return lines.length ? `${lines.length} совпадений:\n${lines.join('\n')}` : 'Совпадений нет';
      }
      let re;
      try {
        re = new RegExp(pattern, 'i');
      } catch (e) {
        throw new Error(`Неверное регулярное выражение: ${e.message}`);
      }
      const files = await walk(dir);
      const filter = glob ? globToRe(glob) : null;
      const hits = [];
      for (const f of files) {
        if (hits.length >= 200) break;
        if (filter && !filter.test(path.relative(dir, f).replace(/\\/g, '/'))) continue;
        const stat = await fs.promises.stat(f).catch(() => null);
        if (!stat || stat.size > 2 * 1024 * 1024) continue;
        const content = await fs.promises.readFile(f, 'utf8').catch(() => '');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (!re.test(lines[i])) continue;
          hits.push(`${path.relative(base, f).replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          if (hits.length >= 200) break;
        }
      }
      if (!hits.length) return 'Совпадений нет';
      return `${hits.length} совпадений:\n${hits.join('\n')}`;
    },
  };

  const runCommand = {
    name: 'run_command',
    description: 'Выполнить команду в терминале (shell). Долгая команда будет остановлена по таймауту.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для выполнения' },
        timeout: { type: 'integer', description: 'Таймаут в миллисекундах, по умолчанию 120000' },
      },
      required: ['command'],
    },
    dangerous: true,
    handler: async ({ command, timeout }) => {
      if (!allowShell) throw new Error('Выполнение команд выключено');
      const limit = Math.min(Number(timeout) || 120000, 600000);
      if (isRemote) return remote.exec(command, { cwd: base, timeout: limit });
      return new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, cwd: base, env: process.env });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Команда не закончилась за ${Math.round(limit / 1000)} с`));
        }, limit);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
        child.on('close', (code) => {
          clearTimeout(timer);
          const body = [out.trim(), err.trim()].filter(Boolean).join('\n').slice(0, 20000);
          resolve(body ? `${body}\n[код ${code}]` : `[код ${code}]`);
        });
      });
    },
  };

  const tools = [readFile, writeFile, editFile, listFiles, searchFiles];
  if (allowShell) tools.push(runCommand);
  return tools;
}

// The knowledge base guard used by the dispatcher: read-only tools that stay
// inside the knowledge base folder and never touch secret-looking files.
export function kbGuard(root) {
  const base = path.resolve(root);
  const inside = (p) => {
    const abs = path.resolve(base, String(p || '.'));
    const rel = path.relative(base, abs);
    return (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) && !isSecret(rel);
  };
  return (toolName, args) => {
    if (!['read_file', 'list_files', 'search_files'].includes(toolName)) {
      throw new Error(`Инструмент ${toolName} недоступен в режиме поиска по базе знаний`);
    }
    const target = args?.path;
    if (target !== undefined && !inside(target)) throw new Error('Можно читать только файлы базы знаний.');
    if (toolName === 'search_files') {
      const pattern = String(args?.pattern || '');
      if (pattern.includes('/') && !inside(pattern)) throw new Error('Такой путь нельзя.');
    }
    return true;
  };
}

export { isSecret };
