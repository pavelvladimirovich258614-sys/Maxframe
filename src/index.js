import { config } from './config.js';
import { addLog, all, run } from './db.js';
import { startWeb } from './web.js';
import { startBot, stopBot } from './max-bot.js';
import { handleMail, handleGroupBatch, classify } from './dispatcher.js';
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

// Self-restart for code changes: wait until no session is running, then exit;
// launchd (KeepAlive) starts the new code. The run that asked finishes its answer first.
let restartRequested = false;
const restartIfIdle = () => {
  if (!restartRequested) return;
  setTimeout(() => {
    if (activeRuns().length) return;
    addLog('system', 'Перезапуск по запросу сессии: применяю новый код');
    process.kill(process.pid, 'SIGTERM');
  }, 5000);
};
onRunFinished(() => restartIfIdle());
setMainframeHandlers({ createTask: (args) => createTask(args), saveSocial: (r) => saveReport(r), addExpense: (e) => addExpense(e), linkedinPost: (a) => linkedin.post(a), linkedinStatus: () => linkedin.status(), contentSaveDrafts: (a) => content.saveDrafts(a), contentMark: (a) => content.markPost(a), contentAddCompetitor: (u) => content.addCompetitor(u), contentAddIdea: (i) => content.addIdea(i), setBalance: (b) => setBalance(b), financeSummaryFor: (days) => ({ items: listExpenses({ from: Date.now() - days * 86400000 }), summary: { today: financeSummary().today, month: financeSummary().month, categories: financeSummary().categories } }), requestRestart: () => { restartRequested = true; addLog('system', 'Запрошен перезапуск мейнфрейма'); restartIfIdle(); } });

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
await startBot();
startTunnel();

if (config.max.enabled) {
  content.startContent();
  startRecall();
  watchGroups(async (batch) => { await handleGroupBatch(batch); });
}

watchMail(async (m) => { await handleMail(m); });
import('./max-bot.js').then(({ sendOwner }) => linkedin.watchExpiry((t) => sendOwner(t).catch(() => {})));

try { const n = rescanInbox(); if (n) addLog('system', `Финансы: добавлено ${n} операций из почты`); } catch (e) { addLog('error', `Финансы: ${e.message}`); }
addLog('system', 'Мейнфрейм запущен');

// Messages whose classification was cut off by a restart: classify them again.
for (const { id } of all("SELECT id FROM inbox WHERE status = 'new' AND created_at > ?", Date.now() - 86400000)) {
  classify(id).catch((e) => addLog('error', `Повторный разбор ${id}: ${e.message}`));
}
// A reply cut off mid-send goes back to the owner's decision.
run("UPDATE inbox SET status = 'routed' WHERE status = 'sending'");

const shutdown = async (signal) => {
  addLog('system', `Остановлен сигналом ${signal}`);
  stopTunnel();
  stopMail();
  stopGroups();
  await stopBot();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => addLog('error', `unhandled: ${e?.message || e}`));
