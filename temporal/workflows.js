// Temporal workflows — orchestration only. No DB, no I/O. All work happens
// inside the proxied activities. Code here must be deterministic.

const { proxyActivities } = require('@temporalio/workflow');

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

module.exports = {
  dailyBillsWorkflow,
  priceHikeWorkflow,
  budgetThresholdWorkflow,
  dailyRecapWorkflow,
  weeklyInsightsWorkflow
};
