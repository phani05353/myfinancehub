// Temporal worker bootstrap — connects, registers activities + workflows,
// and ensures the cron schedules exist (idempotent).

const path = require('path');
const { NativeConnection, Worker } = require('@temporalio/worker');
const { Client, Connection, ScheduleAlreadyRunning } = require('@temporalio/client');

const TASK_QUEUE = 'finance-tq';
const NAMESPACE  = process.env.TEMPORAL_NAMESPACE || 'default';
const ADDRESS    = process.env.TEMPORAL_ADDRESS   || 'localhost:7233';

const SCHEDULES = [
  { id: 'bills-daily',           workflow: 'dailyBillsWorkflow',           cron: '0 8 * * *',   note: '08:00 daily' },
  { id: 'price-hikes-daily',     workflow: 'priceHikeWorkflow',            cron: '0 9 * * *',   note: '09:00 daily' },
  { id: 'budget-threshold-daily',workflow: 'budgetThresholdWorkflow',      cron: '0 20 * * *',  note: '20:00 daily' },
  { id: 'savings-nudge',         workflow: 'savingsNudgeWorkflow',         cron: '0 19 */3 * *',note: '19:00 every 3 days' },
  { id: 'daily-recap',           workflow: 'dailyRecapWorkflow',           cron: '0 21 * * *',  note: '21:00 daily' },
  { id: 'weekly-insights',       workflow: 'weeklyInsightsWorkflow',       cron: '0 18 * * 0',  note: 'Sun 18:00' },
  { id: 'month-end-close',       workflow: 'monthEndCloseWorkflow',        cron: '0 8 1 * *',   note: '1st of month 08:00' },
  { id: 'monthly-report-email',  workflow: 'monthlyReportEmailWorkflow',   cron: '0 21 1 * *',  note: '1st of month 21:00 (prev month report)' },
  { id: 'daily-backup',          workflow: 'dailyBackupWorkflow',          cron: '0 3 * * *',   note: '03:00 daily' },
  { id: 'weekly-integrity-check',workflow: 'weeklyIntegrityCheckWorkflow', cron: '0 4 * * 0',   note: 'Sun 04:00' },
  { id: 'trip-detection',        workflow: 'detectTripsWorkflow',          cron: '0 6 * * *',   note: '06:00 daily' },
  { id: 'push-cleanup',          workflow: 'cleanupPushSubscriptionsWorkflow', cron: '0 4 */3 * *', note: 'every 3 days 04:00' }
];

async function ensureSchedule(client, def) {
  const handle = client.schedule.getHandle(def.id);

  let desc = null;
  try {
    desc = await handle.describe();
  } catch (_) {
    desc = null; // not found — fall through to create
  }

  // Base workflow ID for each scheduled run. Use the schedule id verbatim:
  // Temporal automatically APPENDS the nominal scheduled time (e.g.
  // `-2026-06-21T21:00:00Z`) to guarantee per-run uniqueness, so this stays
  // human-readable and resolvable in the Web UI. Do NOT add a `{{...}}` Go
  // template here — the TS SDK does not expand it, so it ends up as a literal
  // `{{.ScheduledStartTime.Unix}}` inside the workflow id, which breaks every
  // run/trigger lookup in the UI (404) and is redundant with the time suffix.
  const wfId = def.id;

  // Reconcile: if the schedule already exists but its spec OR workflow id
  // drifted from the code, normalize it in place. Without this, changing a cron
  // (or fixing a bad workflow id) here was a no-op on any already-created
  // schedule — the old definition kept firing forever.
  // Compare (and rewrite) the WHOLE trigger set, not just cronExpressions[0]:
  // a schedule can accumulate multiple cron expressions (and stray calendars/
  // intervals) across past updates, and every one of them fires independently.
  if (desc) {
    const current = desc.spec?.cronExpressions ?? [];
    const currentWfId = desc.action?.workflowId ?? '';
    const specInSync =
      current.length === 1 && current[0] === def.cron &&
      !(desc.spec?.calendars?.length) && !(desc.spec?.intervals?.length);
    const wfIdInSync = currentWfId === wfId;
    if (specInSync && wfIdInSync) return 'exists';
    await handle.update((prev) => {
      prev.spec.cronExpressions = [def.cron];
      prev.spec.calendars = [];
      prev.spec.intervals = [];
      prev.action.workflowId = wfId;
      return prev;
    });
    const changes = [];
    if (!specInSync) changes.push(`cron ${current.join(' | ') || 'none'} → ${def.cron}`);
    if (!wfIdInSync) changes.push(`workflowId ${currentWfId || 'none'} → ${wfId}`);
    return `updated (${changes.join('; ')})`;
  }

  await client.schedule.create({
    scheduleId: def.id,
    spec: { cronExpressions: [def.cron] },
    action: {
      type: 'startWorkflow',
      workflowType: def.workflow,
      taskQueue: TASK_QUEUE,
      workflowId: wfId
    },
    policies: { overlap: 'SKIP' }
  });
  return 'created';
}

// Module-level so route handlers can call getClient() to start event-driven workflows
let __client = null;
function getClient() { return __client; }

async function startWorker({ db, sendPushToAll, sendPushExcept, applyRules, ocrReceiptText }) {
  // 1. Worker — runs activities + workflows
  const connection = await NativeConnection.connect({ address: ADDRESS });
  const activities = require('./activities')({ db, sendPushToAll, sendPushExcept, applyRules, ocrReceiptText });
  const worker = await Worker.create({
    connection,
    namespace: NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, 'workflows.js'),
    activities
  });
  worker.run().catch(err => console.error('Worker exited with error:', err));

  // 2. Client — for both schedule registration and on-demand workflow starts
  __client = new Client({
    connection: await Connection.connect({ address: ADDRESS }),
    namespace: NAMESPACE
  });
  for (const def of SCHEDULES) {
    const status = await ensureSchedule(__client, def).catch(e => `error: ${e.message}`);
    console.log(`  schedule ${def.id} (${def.note}) → ${status}`);
  }
}

module.exports = { startWorker, getClient, TASK_QUEUE, NAMESPACE, SCHEDULES };
