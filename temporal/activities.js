// Temporal activities — atomic, idempotent units of work. All I/O happens here.
// The factory pattern injects `db` and the push helper so workflows stay pure.

module.exports = ({ db, sendPushToAll }) => ({

  // ── Bills ──────────────────────────────────────────────────────────────────
  async findDueBills(daysAhead = 1) {
    return db.prepare(`
      SELECT id, title, due_date, amount, category
      FROM reminders
      WHERE paid = 0
        AND due_date BETWEEN date('now') AND date('now', '+' || ? || ' days')
      ORDER BY due_date ASC
    `).all(daysAhead);
  },

  async findOverdueBills() {
    return db.prepare(`
      SELECT id, title, due_date, amount, category
      FROM reminders
      WHERE paid = 0 AND due_date < date('now')
      ORDER BY due_date ASC
    `).all();
  },

  // ── Price hikes (reuses the same logic as the dashboard endpoint) ──────────
  async findPriceHikes() {
    const subs = db.prepare('SELECT * FROM subscriptions WHERE active = 1').all();
    const alerts = [];
    for (const s of subs) {
      const matchName = (s.payee && s.payee.trim()) || s.name;
      if (!matchName) continue;
      const txs = db.prepare(`
        SELECT amount, date FROM transactions
        WHERE amount < 0 AND lower(payee) = lower(?)
          AND date >= date('now', '-90 days')
        ORDER BY date DESC LIMIT 2
      `).all(matchName);
      if (!txs.length) continue;
      const latest   = Math.abs(txs[0].amount);
      const expected = Math.abs(s.amount);
      const previous = txs[1] ? Math.abs(txs[1].amount) : expected;
      const baseline = Math.max(expected, previous);
      const minDelta = Math.max(0.50, baseline * 0.02);
      if (latest > baseline + minDelta) {
        alerts.push({
          name: s.name,
          previous_amount: baseline,
          current_amount: latest,
          increase: latest - baseline,
          pct_increase: baseline > 0 ? ((latest - baseline) / baseline) * 100 : 0
        });
      }
    }
    return alerts;
  },

  // ── Budget at 90% threshold ────────────────────────────────────────────────
  async findBudgetAlerts() {
    const month = new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT b.category, b.amount AS budget, COALESCE(SUM(ABS(t.amount)), 0) AS spent
      FROM budgets b
      LEFT JOIN transactions t
        ON lower(t.category) = lower(b.category)
        AND strftime('%Y-%m', t.date) = ?
        AND t.amount < 0
      GROUP BY b.id
    `).all(month);
    return rows.filter(r => r.budget > 0 && r.spent >= r.budget * 0.9);
  },

  // ── Daily spending recap ───────────────────────────────────────────────────
  async computeDailyRecap() {
    const today = new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT payee, amount FROM transactions
      WHERE date = ? AND amount < 0
    `).all(today);
    const total = rows.reduce((s, r) => s + Math.abs(r.amount), 0);
    return { count: rows.length, total, top: rows.sort((a, b) => a.amount - b.amount)[0] || null };
  },

  // ── Weekly insights digest (light version of dashboard insights) ──────────
  async computeWeeklyInsights() {
    const insights = [];

    // Last 7 days vs prior 7 days
    const last7 = db.prepare(`
      SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM transactions
      WHERE amount < 0 AND date >= date('now', '-7 days')
    `).get().total;
    const prior7 = db.prepare(`
      SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM transactions
      WHERE amount < 0 AND date >= date('now', '-14 days') AND date < date('now', '-7 days')
    `).get().total;
    if (prior7 > 20) {
      const pct = ((last7 - prior7) / prior7) * 100;
      if (Math.abs(pct) >= 10) {
        insights.push(`Spent ${pct > 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}% this week vs last`);
      }
    }

    // Top category this week
    const topCat = db.prepare(`
      SELECT COALESCE(category, 'Uncategorized') AS cat, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE amount < 0 AND date >= date('now', '-7 days')
      GROUP BY cat ORDER BY total DESC LIMIT 1
    `).get();
    if (topCat) {
      insights.push(`Top: ${topCat.cat} ($${topCat.total.toFixed(0)})`);
    }

    // Most-frequent merchant this week
    const topMerchant = db.prepare(`
      SELECT payee, COUNT(*) AS cnt, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE amount < 0 AND date >= date('now', '-7 days') AND payee IS NOT NULL
      GROUP BY lower(payee) ORDER BY cnt DESC LIMIT 1
    `).get();
    if (topMerchant && topMerchant.cnt >= 3) {
      insights.push(`${topMerchant.payee}: ${topMerchant.cnt} visits, $${topMerchant.total.toFixed(0)}`);
    }

    return insights;
  },

  // ── Send push ──────────────────────────────────────────────────────────────
  async sendPush(payload) {
    return sendPushToAll(payload);
  }
});
