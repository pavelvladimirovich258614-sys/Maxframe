import { config } from './config.js';
import { addLog, all, run, kvGet, kvSet } from './db.js';
import { startWeb } from './web.js';
import { startBot, stopBot, activeGroupCount, beginGroupRestart } from './max-bot.js';
import { handleMail, handleGroupBatch, classify, flushBursts } from './dispatcher.js';
import { watchGroups, stopGroups } from './groups.js';
import { watchMail, stopMail } from './mail.js';
import { saveReport, ensureSocialTask } from './social.js';
import * as linkedin from './linkedin.js';
import * as content from './content.js';
import { startRecall } from './recall.js';
import { addExpense, listExpenses, financeSummary, rescanInbox, setBalance } from './finance.js';
import { reloadTasks, createTask } from './scheduler.js';
import { setMainframeHandlers } from './mcp.js';
import { activeRuns, onRunFinished } from './agent.js';
import { startTunnel, stopTunnel } from './tunnel.js';

// Exit with a non-zero code on requested restart so systemd Restart=on-failure
// and launchd KeepAlive both start a new process after graceful shutdown.
let restartRequested = false;
let restartTimer = null;
let exitCode = 0;
const restartIfIdle = () => {
  if (!restartRequested || restartTimer || exitCode) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (activeRuns().length || activeGroupCount()) { restartIfIdle(); return; }
    exitCode = 75;
    addLog('system', 'Перезапуск по запросу');
    process.kill(process.pid, 'SIGTERM');
  }, 5000);
};
function requestRestart() {
  restartRequested = true;
  beginGroupRestart();
  restartIfIdle();
}
onRunFinished(() => restartIfIdle());
setMainframeHandlers({ createTask: (args) => createTask(args), saveSocial: (r) => saveReport(r), addExpense: (e) => addExpense(e), linkedinPost: (a) => linkedin.post(a), linkedinStatus: () => linkedin.status(), contentSaveDrafts: (a) => content.saveDrafts(a), contentMark: (a) => content.markPost(a), contentAddCompetitor: (u) => content.addCompetitor(u), contentAddIdea: (i) => content.addIdea(i), setBalance: (b) => setBalance(b), financeSummaryFor: (days) => ({ items: listExpenses({ from: Date.now() - days * 86400000 }), summary: { today: financeSummary().today, month: financeSummary().month, categories: financeSummary().categories } }), requestRestart });

const previousAuthError = kvGet('auth_error', null);
if (previousAuthError && previousAuthError.kind !== 'minimax-auth') kvSet('auth_error', null);

try {
  await startWeb();
} catch (e) {
  console.error(e.code === 'EADDRINUSE'
    ? `Порт ${config.port} уже занят: мейнфрейм, похоже, уже запущен (автозапуск или другой терминал). Второй экземпляр не стартует.`
    : `Не удалось запустить веб-сервер: ${e.message}`);
  process.exit(1);
}
ensureSocialTask();
reloadTasks();
await startBot({ requestRestart });
startTunnel();

if (config.max.enabled) {
  content.startContent();
  if (process.env.MAX_AUTO_PARSE === '1') startRecall();
  if (process.env.MAX_GROUP_INBOX === '1') watchGroups(async (batch) => { await handleGroupBatch(batch); });
}

watchMail(async (m) => { await handleMail(m); });
import('./max-bot.js').then(({ sendOwner }) => linkedin.watchExpiry((t) => sendOwner(t).catch(() => {})));

try { const n = rescanInbox(); if (n) addLog('system', `Финансы: добавлено ${n} операций из почты`); } catch (e) { addLog('error', `Финансы: ${e.message}`); }
addLog('system', 'Мейнфрейм запущен');

// Messages whose classification was cut off by a restart: classify them again.
for (const { id } of all("SELECT id FROM inbox WHERE status = 'new' AND created_at > ?", Date.now() - 86400000)) {
  classify(id).catch((e) => addLog('error', `Повторный разбор ${id}: ${e.message}`));
}
// Messages that arrived before the crash and had not become a card yet.
flushBursts().catch((e) => addLog('error', `Входящие: ${e.message}`));
// A reply cut off mid-send goes back to the owner's decision.
run("UPDATE inbox SET status = 'routed' WHERE status = 'sending'");

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  // Incoming bursts are persisted and can be recovered on the next startup.
  setTimeout(() => process.exit(exitCode), 15000).unref();
  addLog('system', `Остановлен сигналом ${signal}`);
  stopTunnel();
  stopMail();
  stopGroups();
  // The messages collected but not yet turned into a card are flushed first:
  // otherwise the last burst is lost.
  await stopBot();
  await flushBursts().catch((e) => addLog('error', `Входящие: ${e.message}`));
  process.exit(exitCode);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => addLog('error', `unhandled: ${e?.message || e}`));
