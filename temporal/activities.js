// Temporal activities — atomic, idempotent units of work. All I/O happens here.
// The factory pattern injects `db` and the push helper so workflows stay pure.

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const DB_PATH     = path.join(DATA_DIR, 'finance.db');
const BACKUP_DIR  = path.join(DATA_DIR, 'backups');

module.exports = ({ db, sendPushToAll, sendPushExcept }) => ({

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

  // ── Month-end close ────────────────────────────────────────────────────────
  // Computes totals for the PREVIOUS calendar month. Resolves "previous month"
  // via SQL (date('now', '-1 day')) so it stays correct regardless of when
  // exactly on the 1st the schedule fires.
  async computeMonthEndSummary() {
    const prev = db.prepare(
      "SELECT strftime('%Y-%m', date('now', '-1 day')) AS m"
    ).get().m;

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS spent,
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount       ELSE 0 END), 0) AS income,
        COUNT(*) AS txCount
      FROM transactions
      WHERE strftime('%Y-%m', date) = ?
    `).get(prev);

    const topCat = db.prepare(`
      SELECT COALESCE(category, 'Uncategorized') AS cat, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE amount < 0 AND strftime('%Y-%m', date) = ?
      GROUP BY cat
      ORDER BY total DESC
      LIMIT 1
    `).get(prev);

    const monthLabel = new Date(prev + '-01T00:00:00')
      .toLocaleString('en-US', { month: 'long' });

    return {
      month: prev,
      monthLabel,
      spent: totals.spent,
      income: totals.income,
      net: totals.income - totals.spent,
      txCount: totals.txCount,
      topCategory: topCat?.cat || null,
      topCategoryTotal: topCat?.total || 0
    };
  },

  // ── Send push ──────────────────────────────────────────────────────────────
  async sendPush(payload) {
    return sendPushToAll(payload);
  },

  // Prune push subscriptions that haven't been confirmed alive recently.
  // `last_seen` is bumped on every successful webpush.sendNotification, so a
  // stale value means the device is uninstalled, has revoked permission, or
  // is otherwise unreachable. The live 404/410 cleanup in sendPushToAll
  // catches outright-dead endpoints; this catches the silent rot.
  async cleanupPushSubscriptions({ staleDays = 30 } = {}) {
    const before = db.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions').get().cnt;
    const result = db.prepare(
      "DELETE FROM push_subscriptions WHERE last_seen IS NULL OR last_seen < datetime('now', '-' || ? || ' days')"
    ).run(staleDays);
    const after = db.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions').get().cnt;
    return { staleDays, before, deleted: result.changes, remaining: after };
  },

  // Variant that excludes one endpoint (used by event-driven workflows
  // like tx-added — the originating device is excluded so it doesn't ding itself)
  async sendPushExceptActivity(excludeEndpoint, payload) {
    return sendPushExcept(excludeEndpoint, payload);
  },

  // ── Database backups & integrity ───────────────────────────────────────────

  // Snapshot finance.db using SQLite's online backup API, then verify the
  // copy by running PRAGMA integrity_check on it. Throws if verification
  // fails (and deletes the bad backup) so Temporal retries / surfaces the error.
  async createDatabaseBackup() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `finance-${ts}.db`);

    // Online backup — safe even while the app keeps reading/writing.
    await db.backup(dest);

    // Verify by opening the backup read-only and running integrity_check on it.
    const verify = new Database(dest, { readonly: true, fileMustExist: true });
    let integrity;
    try {
      integrity = verify.prepare('PRAGMA integrity_check').get()?.integrity_check;
    } finally {
      verify.close();
    }
    if (integrity !== 'ok') {
      fs.unlinkSync(dest);
      throw new Error(`Backup verification failed: ${integrity}`);
    }

    const size = fs.statSync(dest).size;
    return { path: dest, name: path.basename(dest), size, timestamp: ts };
  },

  // Keep the most recent N backups, delete the rest.
  async pruneOldBackups(retain = 14) {
    if (!fs.existsSync(BACKUP_DIR)) return { kept: 0, deleted: 0 };
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^finance-.*\.db$/.test(f))
      .map(f => {
        const fp = path.join(BACKUP_DIR, f);
        return { name: f, path: fp, mtime: fs.statSync(fp).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    const toKeep   = files.slice(0, retain);
    const toDelete = files.slice(retain);
    toDelete.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    return { kept: toKeep.length, deleted: toDelete.length };
  },

  // Run PRAGMA integrity_check on the live DB. Read-only, safe while the
  // app is running. Returns { ok: bool, details: string }.
  async runIntegrityCheck() {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const messages = rows.map(r => r.integrity_check);
    const ok = messages.length === 1 && messages[0] === 'ok';
    return { ok, details: messages.join(' | ').slice(0, 500) };
  },

  // List backups newest-first (used by the integrity workflow's alert push
  // so the admin knows what's available to restore from).
  async listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => /^finance-.*\.db$/.test(f))
      .map(f => {
        const fp = path.join(BACKUP_DIR, f);
        const s = fs.statSync(fp);
        return { name: f, size: s.size, mtime: s.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  },

  // ── Trip detection ─────────────────────────────────────────────────────────
  //
  // Heuristic: a "trip" is a window where ≥3 distinct payees appear that
  // were never seen in transaction history before the window. No
  // geolocation needed — new merchants are a strong proxy for travel.

  async findNewPayeeClusters({ windowDays = 7, minNewPayees = 3 } = {}) {
    const newPayees = db.prepare(`
      SELECT lower(payee) as p, MIN(date) as first_seen
      FROM transactions
      WHERE amount < 0
        AND payee IS NOT NULL
        AND date >= date('now', '-' || ? || ' days')
        AND lower(payee) NOT IN (
          SELECT DISTINCT lower(payee) FROM transactions
          WHERE date < date('now', '-' || ? || ' days') AND payee IS NOT NULL
        )
      GROUP BY lower(payee)
      ORDER BY first_seen ASC
    `).all(windowDays, windowDays);

    if (newPayees.length < minNewPayees) return [];
    return [{
      tripStartDate: newPayees[0].first_seen,
      initialPayeeCount: newPayees.length
    }];
  },

  // Is the trip still active? Check for any expense transaction in the last
  // `withinDays` whose payee was new at trip start. Returns count for
  // logging visibility.
  async hasRecentTripActivity({ tripStartDate, withinDays = 2 }) {
    const newPayees = db.prepare(`
      SELECT DISTINCT lower(payee) as p FROM transactions
      WHERE amount < 0 AND payee IS NOT NULL AND date >= ?
        AND lower(payee) NOT IN (
          SELECT DISTINCT lower(payee) FROM transactions
          WHERE date < ? AND payee IS NOT NULL
        )
    `).all(tripStartDate, tripStartDate);

    if (newPayees.length === 0) return { active: false, count: 0 };

    const placeholders = newPayees.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE amount < 0
        AND date >= date('now', '-' || ? || ' days')
        AND lower(payee) IN (${placeholders})
    `).get(withinDays, ...newPayees.map(p => p.p));
    return { active: row.cnt > 0, count: row.cnt };
  },

  // Conclude a trip — totals + top category + date range, based on all
  // expense transactions from tripStartDate with payees new at that time.
  async summarizeTrip({ tripStartDate }) {
    const newPayees = db.prepare(`
      SELECT DISTINCT lower(payee) as p FROM transactions
      WHERE amount < 0 AND payee IS NOT NULL AND date >= ?
        AND lower(payee) NOT IN (
          SELECT DISTINCT lower(payee) FROM transactions
          WHERE date < ? AND payee IS NOT NULL
        )
    `).all(tripStartDate, tripStartDate);
    if (newPayees.length === 0) return { count: 0, total: 0 };

    const placeholders = newPayees.map(() => '?').join(',');
    const txs = db.prepare(`
      SELECT payee, category, ABS(amount) as amt, date
      FROM transactions
      WHERE amount < 0
        AND date >= ?
        AND lower(payee) IN (${placeholders})
      ORDER BY date ASC
    `).all(tripStartDate, ...newPayees.map(p => p.p));

    if (txs.length === 0) return { count: 0, total: 0 };
    const total = txs.reduce((s, t) => s + t.amt, 0);
    const cats = {};
    txs.forEach(t => {
      const c = t.category || 'Uncategorized';
      cats[c] = (cats[c] || 0) + t.amt;
    });
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
    return {
      startDate: tripStartDate,
      endDate: txs[txs.length - 1].date,
      count: txs.length,
      total: Math.round(total * 100) / 100,
      topCategory: top?.[0] || null,
      payeeCount: newPayees.length
    };
  }
});
