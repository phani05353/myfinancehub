// Temporal workflows — orchestration only. No DB, no I/O. All work happens
// inside the proxied activities. Code here must be deterministic.

const { proxyActivities, sleep, startChild, ParentClosePolicy } = require('@temporalio/workflow');

const acts = proxyActivities({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 }
});

// 8 AM daily — push a single notification combining due + overdue bills.
async function dailyBillsWorkflow() {
  const [due, overdue] = await Promise.all([
    acts.findDueBills(1),
    acts.findOverdueBills()
  ]);
  if (due.length === 0 && overdue.length === 0) return { sent: false };

  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (due.length)     parts.push(`${due.length} due tomorrow`);
  const sample = [...overdue, ...due].slice(0, 3).map(b => b.title).join(', ');

  return acts.sendPush({
    title: `🔔 Bills: ${parts.join(' · ')}`,
    body: sample + ((overdue.length + due.length) > 3 ? ' and more' : ''),
    tag: 'bills',
    data: { route: '#/reminders' }
  });
}

// 9 AM daily — push when a subscription got more expensive than usual.
async function priceHikeWorkflow() {
  const alerts = await acts.findPriceHikes();
  if (alerts.length === 0) return { sent: false };
  const top = alerts[0];
  const body = alerts.length === 1
    ? `${top.name}: $${top.previous_amount.toFixed(2)} → $${top.current_amount.toFixed(2)} (+${top.pct_increase.toFixed(1)}%)`
    : `${top.name} and ${alerts.length - 1} more increased — tap to review`;
  return acts.sendPush({
    title: `📈 Price hike on ${alerts.length} subscription${alerts.length > 1 ? 's' : ''}`,
    body,
    tag: 'price-hike',
    data: { route: '#/dashboard' }
  });
}

// 8 PM daily — push when any budget category is ≥ 90% used.
async function budgetThresholdWorkflow() {
  const breached = await acts.findBudgetAlerts();
  if (breached.length === 0) return { sent: false };
  const top = breached.sort((a, b) => (b.spent / b.budget) - (a.spent / a.budget))[0];
  const pct = (top.spent / top.budget) * 100;
  return acts.sendPush({
    title: `💰 ${top.category} at ${pct.toFixed(0)}% of budget`,
    body: `$${top.spent.toFixed(0)} of $${top.budget.toFixed(0)}${breached.length > 1 ? ` (+${breached.length - 1} other categor${breached.length > 2 ? 'ies' : 'y'})` : ''}`,
    tag: 'budget',
    data: { route: '#/budget' }
  });
}

// 9 PM daily — recap of what you spent today.
async function dailyRecapWorkflow() {
  const recap = await acts.computeDailyRecap();
  if (recap.count === 0) return { sent: false };
  const topPart = recap.top ? ` · biggest: ${recap.top.payee} $${Math.abs(recap.top.amount).toFixed(0)}` : '';
  return acts.sendPush({
    title: `📊 Today: $${recap.total.toFixed(2)}`,
    body: `${recap.count} transaction${recap.count > 1 ? 's' : ''}${topPart}`,
    tag: 'daily-recap',
    data: { route: '#/transactions' }
  });
}

// Sunday 6 PM — weekly insights digest.
async function weeklyInsightsWorkflow() {
  const insights = await acts.computeWeeklyInsights();
  if (insights.length === 0) return { sent: false };
  return acts.sendPush({
    title: '💡 Weekly Insights',
    body: insights.slice(0, 3).join(' · '),
    tag: 'weekly-insights',
    data: { route: '#/dashboard' }
  });
}

// Event-driven (not scheduled): fired from the API handler whenever a
// transaction is added, so every push attempt gets a workflow row in the
// Temporal UI with full payload, retries, and timing.
async function sendPushWorkflow({ excludeEndpoint, payload }) {
  return acts.sendPushExceptActivity(excludeEndpoint, payload);
}

// 3 AM daily — snapshot finance.db, verify the snapshot, prune old backups.
// Silent on success; the workflow's own success/failure is the audit trail
// (visible in Temporal UI). Sends a push only if the backup itself fails.
async function dailyBackupWorkflow() {
  let backup, pruned;
  try {
    backup = await acts.createDatabaseBackup();
    pruned = await acts.pruneOldBackups(14);
  } catch (err) {
    await acts.sendPush({
      title: '⚠ Daily backup FAILED',
      body: String(err.message || err).slice(0, 150),
      tag: 'backup-fail',
      data: { route: '#/dashboard' }
    });
    throw err; // mark the workflow as failed so it's flagged in Temporal UI
  }
  return { backup, pruned };
}

// Sunday 4 AM — run PRAGMA integrity_check. On failure, push a CRITICAL
// alert to every subscribed device with the diagnosis and the latest
// available backup name so the admin knows what to restore from.
async function weeklyIntegrityCheckWorkflow() {
  const result = await acts.runIntegrityCheck();
  if (result.ok) return { status: 'ok' };

  const backups = await acts.listBackups();
  const latest  = backups[0]?.name || 'NONE — restore not possible';

  await acts.sendPush({
    title: '🚨 Database integrity check FAILED',
    body: `Corruption detected: ${result.details.slice(0, 100)}. Latest backup: ${latest}. Restore ASAP.`,
    tag: 'db-integrity-fail',
    data: { route: '#/dashboard' }
  });
  return { status: 'failed', details: result.details, latestBackup: latest };
}

// ── Trip detection ──────────────────────────────────────────────────────────
// Daily cron — scan for any new-payee cluster and spawn a per-trip tracker.
// Uses startChild with ABANDON so the spawned workflow outlives this one.
async function detectTripsWorkflow() {
  const clusters = await acts.findNewPayeeClusters({});
  if (clusters.length === 0) return { started: 0, candidates: 0 };

  let started = 0;
  for (const cluster of clusters) {
    try {
      // Deterministic workflow ID = if a trip is already being tracked from
      // this start date, the duplicate start is rejected and we skip silently.
      await startChild('tripDetectionWorkflow', {
        workflowId: `trip-${cluster.tripStartDate}`,
        parentClosePolicy: ParentClosePolicy.ABANDON,
        args: [cluster]
      });
      started++;
    } catch (_) {
      // Already running for this trip start — fine.
    }
  }
  return { started, candidates: clusters.length };
}

// Per-trip workflow — sleeps in 2-day chunks until "trip activity" dies
// down, then sends a single summary push. Max iterations cap protects
// against pathological data (someone who explores new merchants daily).
async function tripDetectionWorkflow({ tripStartDate }) {
  const MAX_ITERATIONS = 30;       // ~60 days of trip — safety cap
  const QUIET_WINDOW   = 2;        // days of silence to declare the trip over

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    await sleep('2 days');
    const status = await acts.hasRecentTripActivity({
      tripStartDate, withinDays: QUIET_WINDOW
    });
    if (!status.active) break;
  }

  const summary = await acts.summarizeTrip({ tripStartDate });
  if (summary.count < 3 || summary.total < 50) {
    return { ...summary, skipped: 'too-small' };
  }

  const [sy, sm, sd] = summary.startDate.split('-');
  const [ey, em, ed] = summary.endDate.split('-');
  const sameMonth = sm === em && sy === ey;
  const dateLabel = sameMonth
    ? `${sm}/${sd}–${ed}`
    : `${sm}/${sd} – ${em}/${ed}`;

  await acts.sendPush({
    title: `✈️ Trip detected (${dateLabel})`,
    body: `${summary.count} transactions · $${summary.total.toFixed(2)} total${summary.topCategory ? ` · top: ${summary.topCategory}` : ''}`,
    tag: `trip-${tripStartDate}`,
    data: { route: '#/transactions' }
  });

  return summary;
}

module.exports = {
  dailyBillsWorkflow,
  priceHikeWorkflow,
  budgetThresholdWorkflow,
  dailyRecapWorkflow,
  weeklyInsightsWorkflow,
  sendPushWorkflow,
  dailyBackupWorkflow,
  weeklyIntegrityCheckWorkflow,
  detectTripsWorkflow,
  tripDetectionWorkflow
};
