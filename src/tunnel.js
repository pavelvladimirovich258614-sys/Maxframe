// Telegram opens Mini Apps only over https. Without PUBLIC_URL we start a Cloudflare
// quick tunnel (no account needed) and pick up its random https address.
import { spawn, execFileSync } from 'node:child_process';
import { config } from './config.js';
import { addLog } from './db.js';
import { bus } from './bus.js';

export const tunnelState = { status: 'off', url: null };
let child = null;

export function startTunnel(onUrl) {
  if (config.publicUrl) {
    Object.assign(tunnelState, { status: 'static', url: config.publicUrl });
    return;
  }
  if (config.tunnel !== 'cloudflared') return;
  try {
    execFileSync('which', ['cloudflared']);
  } catch {
    tunnelState.status = 'no_cloudflared';
    return;
  }
  child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${config.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelState.status = 'starting';
  const scan = (d) => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== tunnelState.url) {
      Object.assign(tunnelState, { status: 'running', url: m[0] });
      config.publicUrl = m[0];
      addLog('system', `Mini App доступен по ${m[0]}`);
      bus.change('tunnel');
      onUrl?.(m[0]);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('exit', (code) => {
    Object.assign(tunnelState, { status: 'stopped', url: null });
    config.publicUrl = '';
    addLog('system', `Туннель остановился (код ${code}), перезапуск через 10 с`);
    setTimeout(() => startTunnel(onUrl), 10000);
  });
}

export function stopTunnel() {
  if (child) {
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
  }
}
