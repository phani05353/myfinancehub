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
  { id: 'daily-recap',           workflow: 'dailyRecapWorkflow',           cron: '0 21 * * *',  note: '21:00 daily' },
  { id: 'weekly-insights',       workflow: 'weeklyInsightsWorkflow',       cron: '0 18 * * 0',  note: 'Sun 18:00' },
  { id: 'daily-backup',          workflow: 'dailyBackupWorkflow',          cron: '0 3 * * *',   note: '03:00 daily' },
  { id: 'weekly-integrity-check',workflow: 'weeklyIntegrityCheckWorkflow', cron: '0 4 * * 0',   note: 'Sun 04:00' },
  { id: 'trip-detection',        workflow: 'detectTripsWorkflow',          cron: '0 6 * * *',   note: '06:00 daily' },
  { id: 'push-cleanup',          workflow: 'cleanupPushSubscriptionsWorkflow', cron: '0 4 */3 * *', note: 'every 3 days 04:00' }
];

async function ensureSchedule(client, def) {
  const handle = client.schedule.getHandle(def.id);
  try {
    await handle.describe();
    return 'exists';
  } catch (_) {
    // not found, create
  }
  await client.schedule.create({
    scheduleId: def.id,
    spec: { cronExpressions: [def.cron] },
    action: {
      type: 'startWorkflow',
      workflowType: def.workflow,
      taskQueue: TASK_QUEUE,
      workflowId: `${def.id}-{{.ScheduledStartTime.Unix}}`
    },
    policies: { overlap: 'SKIP' }
  });
  return 'created';
}

// Module-level so route handlers can call getClient() to start event-driven workflows
let __client = null;
function getClient() { return __client; }

async function startWorker({ db, sendPushToAll, sendPushExcept }) {
  // 1. Worker — runs activities + workflows
  const connection = await NativeConnection.connect({ address: ADDRESS });
  const activities = require('./activities')({ db, sendPushToAll, sendPushExcept });
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
