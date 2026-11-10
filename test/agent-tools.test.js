import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localTools, kbGuard } from '../src/agent-tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mainframe-tools-'));

test('reads a file with line numbers', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'один\nдва\nтри\n');
  const tools = localTools({ cwd: dir });
  const read = tools.find((t) => t.name === 'read_file');
  const out = await read.handler({ path: 'a.txt' });
  assert.equal(out, '1\tодин\n2\tдва\n3\tтри');
});

test('writes and edits a file', async () => {
  const dir = tmp();
  const tools = localTools({ cwd: dir });
  const write = tools.find((t) => t.name === 'write_file');
  const edit = tools.find((t) => t.name === 'edit_file');
  await write.handler({ path: 'sub/b.txt', content: 'привет' });
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'b.txt'), 'utf8'), 'привет');
  await edit.handler({ path: 'sub/b.txt', old_string: 'привет', new_string: 'пока' });
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'b.txt'), 'utf8'), 'пока');
});

test('an edit refuses an ambiguous fragment unless replace_all is set', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'c.txt'), 'a a a');
  const edit = localTools({ cwd: dir }).find((t) => t.name === 'edit_file');
  await assert.rejects(edit.handler({ path: 'c.txt', old_string: 'a', new_string: 'b' }), /встречается 3 раза/);
  await edit.handler({ path: 'c.txt', old_string: 'a', new_string: 'b', replace_all: true });
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'b b b');
});

test('a tool with a root never leaves the folder', async () => {
  const dir = tmp();
  const inside = path.join(dir, 'kb');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'note.md'), 'заметка');
  const read = localTools({ cwd: dir, root: inside }).find((t) => t.name === 'read_file');
  await assert.rejects(read.handler({ path: path.join(dir, 'outside.md') }), /Вне рабочей папки/);
  assert.match(await read.handler({ path: 'note.md' }), /заметка/);
});

test('secret files are never read', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'key.pem'), '-----BEGIN');
  const read = localTools({ cwd: dir }).find((t) => t.name === 'read_file');
  await assert.rejects(read.handler({ path: '.env' }), /Секретные файлы/);
  await assert.rejects(read.handler({ path: 'key.pem' }), /Секретные файлы/);
});

test('search finds lines by a regular expression', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.md'), 'Первая строка\nсовпадение тут\nтретья');
  fs.writeFileSync(path.join(dir, 'b.md'), 'мимо');
  const search = localTools({ cwd: dir }).find((t) => t.name === 'search_files');
  const out = await search.handler({ pattern: 'совпадение' });
  assert.match(out, /a\.md:2/);
});

test('the knowledge base guard allows documents and refuses everything else', () => {
  const dir = tmp();
  const guard = kbGuard(dir);
  assert.equal(guard('read_file', { path: 'note.md' }), true);
  assert.throws(() => guard('read_file', { path: '../secret.md' }), /только файлы базы знаний/);
  assert.throws(() => guard('run_command', { command: 'ls' }), /недоступен/);
});

test('the shell tool is missing when it is not allowed', () => {
  const dir = tmp();
  assert.ok(localTools({ cwd: dir, allowShell: false }).every((t) => t.name !== 'run_command'));
  assert.ok(localTools({ cwd: dir }).some((t) => t.name === 'run_command'));
});
