// Commands on the owner's Mac.
//
// The old mechanism ran the Claude CLI on the Mac over SSH, because the Agent
// SDK could drive a remote CLI. MiniMax has no such CLI, so the part that
// mattered is done directly: a command runs on the Mac over the same tunnel
// (ssh -p 2222 through the local port forward).
//
// What stays on the server: the conversation itself, the memory and the journal.
// What runs on the Mac: the commands of the project whose files live there.

import { spawn } from 'node:child_process';
import { config } from './config.js';

export function macConfigured() {
  return Boolean(config.mac.user);
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The ssh call that runs a shell command on the Mac in the given folder.
function sshArgs(command, cwd) {
  const remote = `cd ${shellQuote(cwd)} 2>/dev/null || cd ~; ${command}`;
  return [
    '-p', String(config.mac.sshPort),
    '-i', config.mac.sshKey,
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    `${config.mac.user}@127.0.0.1`,
    remote,
  ];
}

// Run a command on the Mac and return its output.
export function macExec(command, { cwd, timeout = 120000, stdin = null } = {}) {
  if (!macConfigured()) return Promise.reject(new Error('MAC_USER не задан в .env'));
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs(command, cwd || process.cwd()), { env: process.env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Команда на Mac не закончилась за ${Math.round(timeout / 1000)} с`));
    }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = [out.trim(), err.trim()].filter(Boolean).join('\n').slice(0, 20000);
      resolve(body ? `${body}\n[код ${code}]` : `[код ${code}]`);
    });
    if (stdin !== null) child.stdin.end(stdin);
  });
}

// The files of a Mac project are not on the server: reading and writing them
// goes through the same SSH channel. The content of a write travels through
// the standard input, so it never appears in the process list.
export async function macRead(filePath) {
  const out = await macExec(`cat ${shellQuote(filePath)}`, { timeout: 60000 });
  return out.replace(/\n\[код \d+\]$/, '');
}

export async function macWrite(filePath, content) {
  const dir = filePath.replace(/[/\\][^/\\]*$/, '');
  await macExec(`mkdir -p ${shellQuote(dir)}`, { timeout: 60000 });
  await macExec(`cat > ${shellQuote(filePath)}`, { timeout: 60000, stdin: content });
  return `Записано: ${filePath}`;
}
