// Temporal activities — atomic, idempotent units of work. All I/O happens here.
// The factory pattern injects `db` and the push helper so workflows stay pure.

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const { monthlyReportHtml, monthlyReportSubject } = require('./email-template');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const DB_PATH      = path.join(DATA_DIR, 'finance.db');
const BACKUP_DIR   = path.join(DATA_DIR, 'backups');
const RECEIPTS_DIR = path.join(__dirname, '..', 'uploads', 'receipts');

// Local LLM (Ollama native /api/generate). Configurable via env so the homelab
// box address / model can change without code edits. Never a cloud call.
const LLM_URL   = process.env.LLM_URL   || 'http://192.168.50.34:11434/api/generate';
const LLM_MODEL = process.env.LLM_MODEL || 'gemma3:4b';   // multimodal; override via env

// Call the local model and coerce its reply to a JSON object. `images` is an
// array of base64 strings (Ollama uses these for vision-capable models; non-
// vision models simply ignore them, which is why the caller has an OCR fallback).
async function callOllamaJson({ model, prompt, images }) {
  const body = { model, prompt, stream: false, format: 'json', options: { temperature: 0 } };
  if (images && images.length) body.images = images;

  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const raw = (data && data.response) || '';     // /api/generate → { response: "<text>" }
  try { return JSON.parse(raw); }
  catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);           // salvage a JSON object if wrapped in prose
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    throw new Error('LLM response was not valid JSON');
  }
}

module.exports = ({ db, sendPushToAll, sendPushExcept, applyRules, ocrReceiptText }) => ({

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

  // ── Savings goals nudge ──────────────────────────────────────────────────────
  // Classify each active goal into one of three nudge buckets, newest-reached
  // first. The workflow decides what (if anything) to push; this activity is
  // pure data so the "skip silently when nothing to say" rule lives in the
  // deterministic workflow. Buckets:
  //   - reached: saved >= target (celebrate, once — see lastNudge dedupe below)
  //   - behind:  has a target_date, not reached, and the required monthly pace
  //              to still hit it has climbed meaningfully above the original
  //              even pace (i.e. contributions have fallen behind schedule)
  //   - nudge:   active, unfunded-this-period goals that just want a gentle
  //              "contribute something" reminder
  async findSavingsNudges() {
    const goals = db.prepare(
      'SELECT * FROM savings_goals WHERE active = 1'
    ).all();
    if (goals.length === 0) return { reached: [], behind: [], nudge: [] };

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const msPerDay = 24 * 60 * 60 * 1000;

    const reached = [], behind = [], nudge = [];
    for (const g of goals) {
      const remaining = g.target_amount - g.saved_amount;
      if (remaining <= 0) {
        reached.push({ id: g.id, name: g.name, target_amount: g.target_amount, saved_amount: g.saved_amount });
        continue;
      }

      if (g.target_date) {
        const target = new Date(g.target_date + 'T00:00:00');
        const daysLeft = Math.round((target - today) / msPerDay);
        if (daysLeft >= 0) {
          const monthsLeft = Math.max(1, daysLeft / 30.44);
          const perMonth = remaining / monthsLeft;
          // "Behind" heuristic: the catch-up pace needed now is >25% higher than
          // an even pace from goal creation would have been. createdMonths uses
          // created_at so a brand-new goal isn't flagged immediately.
          const created = new Date((g.created_at || '').replace(' ', 'T') + 'Z');
          const totalMonths = isNaN(created) ? monthsLeft : Math.max(1, (target - created) / msPerDay / 30.44);
          const evenPace = g.target_amount / totalMonths;
          if (perMonth > evenPace * 1.25) {
            behind.push({ id: g.id, name: g.name, perMonth, daysLeft, remaining });
            continue;
          }
        } else {
          // Past the target date and still short — definitely behind.
          behind.push({ id: g.id, name: g.name, perMonth: remaining, daysLeft, remaining });
          continue;
        }
      }

      nudge.push({ id: g.id, name: g.name, remaining, saved_amount: g.saved_amount, target_amount: g.target_amount });
    }
    return { reached, behind, nudge };
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

  // ── Receipt ingest (local vision LLM) ───────────────────────────────────────
  // Read a stored receipt image and extract structured fields with the local
  // model. Tries vision first (image sent directly); if that yields nothing
  // useful, OCRs the image to text and asks the model to structure the text.
  async extractReceiptWithLLM({ receiptFile }) {
    const imgPath = path.join(RECEIPTS_DIR, receiptFile);
    const buffer  = fs.readFileSync(imgPath);

    const schemaHint =
      'Respond with ONLY a JSON object: ' +
      '{"merchant": string, "date": "YYYY-MM-DD" or null, "total": number, ' +
      '"currency": string, "category": string or null, ' +
      '"items": [{"name": string, "price": number}]}. ' +
      'total is the final grand total actually paid.';

    const usable = p => p && (p.merchant || p.total > 0);
    let parsed = null;
    let lastError = null;   // captured so the thrown message says WHY (network? 404? bad JSON?)

    // 1) Vision attempt — send the image bytes directly.
    try {
      parsed = await callOllamaJson({
        model: LLM_MODEL,
        prompt: `You are a receipt parser. Read this receipt image and extract the merchant, purchase date, grand total, and line items. ${schemaHint}`,
        images: [buffer.toString('base64')]
      });
      if (!usable(parsed)) { lastError = lastError || 'vision: model returned no usable fields (not vision-capable?)'; parsed = null; }
    } catch (err) {
      lastError = `vision: ${err.message}`;
      console.error('[receipt-ai] vision attempt failed:', err.message);
    }

    // 2) Fallback — OCR to text, then structure the text (works with text-only models).
    if (!parsed) {
      let text = '';
      try { text = (await ocrReceiptText(buffer)) || ''; }
      catch (e) { lastError = `ocr: ${e.message}`; console.error('[receipt-ai] ocr fallback failed:', e.message); }

      if (text.trim()) {
        try {
          const fromText = await callOllamaJson({
            model: LLM_MODEL,
            prompt: `You are a receipt parser. Below is the raw OCR text of a receipt:\n"""\n${text.slice(0, 4000)}\n"""\nExtract the fields. ${schemaHint}`
          });
          if (usable(fromText)) parsed = fromText;
          else lastError = 'text: model returned no usable fields from OCR text';
        } catch (err) {
          lastError = `text: ${err.message}`;
          console.error('[receipt-ai] text attempt failed:', err.message);
        }
      } else if (!lastError) {
        lastError = 'ocr: produced no text (image unreadable or empty)';
      }
    }

    if (!parsed) {
      throw new Error(`Receipt extraction failed [model=${LLM_MODEL} url=${LLM_URL}]: ${lastError || 'no data returned'}`);
    }
    return parsed;
  },

  // Insert a transaction from the extracted fields. Flagged needs_review = 1 and
  // source = 'receipt-ai' so it surfaces for confirmation rather than being
  // silently trusted. Amount is stored negative (expense), per app convention.
  async createTransactionFromReceipt({ extracted, receiptFile }) {
    const today = new Date().toISOString().slice(0, 10);
    const payee = String(extracted.merchant || 'Unknown merchant').trim().slice(0, 80) || 'Unknown merchant';
    const total = Math.abs(parseFloat(extracted.total) || 0);
    const amount = -total;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(extracted.date || '') ? extracted.date : today;

    const items = Array.isArray(extracted.items) ? extracted.items : [];
    const itemLines = items
      .filter(i => i && i.name)
      .map(i => `- ${String(i.name).slice(0, 60)}${i.price != null ? ` $${Number(i.price).toFixed(2)}` : ''}`)
      .join('\n');
    const notes = ['🧾 Auto-extracted from receipt (needs review)', itemLines]
      .filter(Boolean).join('\n').slice(0, 1000);

    const resolved = applyRules({ payee, amount, notes, category: extracted.category || null });

    const result = db.prepare(
      "INSERT INTO transactions (date, payee, category, amount, notes, source, receipt_path, needs_review) " +
      "VALUES (?, ?, ?, ?, ?, 'receipt-ai', ?, 1)"
    ).run(date, payee, resolved.category, amount, notes, receiptFile);

    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
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
  },

  // ── Monthly report (emailed) ───────────────────────────────────────────────
  // Builds a rich summary for the PREVIOUS (just-completed) calendar month.
  // Scheduled on the 1st, so the month's data is final and the email fires
  // exactly once — no "last day of month" cron gymnastics needed.
  async computeMonthlyReport() {
    const cal = db.prepare(`
      SELECT strftime('%Y-%m', date('now','start of month','-1 day'))               AS month,
             date('now')                                                            AS today,
             CAST(strftime('%d', date('now','start of month','-1 day')) AS INTEGER) AS daysInMonth
    `).get();
    const month = cal.month;

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS spent,
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount       ELSE 0 END), 0) AS income,
        COUNT(*) AS txCount
      FROM transactions WHERE strftime('%Y-%m', date) = ?
    `).get(month);

    const spent = totals.spent;
    const income = totals.income;
    const net = income - spent;

    const topCategories = db.prepare(`
      SELECT COALESCE(category, 'Uncategorized') AS cat, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE amount < 0 AND strftime('%Y-%m', date) = ?
      GROUP BY cat ORDER BY total DESC LIMIT 6
    `).all(month).map(c => ({
      cat: c.cat,
      total: c.total,
      pct: spent > 0 ? (c.total / spent) * 100 : 0
    }));

    const topMerchants = db.prepare(`
      SELECT payee, COUNT(*) AS cnt, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE amount < 0 AND strftime('%Y-%m', date) = ? AND payee IS NOT NULL AND payee != ''
      GROUP BY lower(payee) ORDER BY total DESC LIMIT 5
    `).all(month);

    const biggestExpenses = db.prepare(`
      SELECT payee, ABS(amount) AS amount, date, category
      FROM transactions
      WHERE amount < 0 AND strftime('%Y-%m', date) = ?
      ORDER BY ABS(amount) DESC LIMIT 5
    `).all(month);

    const prevMonth = db.prepare(
      "SELECT strftime('%Y-%m', date('now','start of month','-1 day','start of month','-1 day')) AS m"
    ).get().m;
    const prevSpent = db.prepare(`
      SELECT COALESCE(SUM(ABS(amount)), 0) AS total
      FROM transactions WHERE amount < 0 AND strftime('%Y-%m', date) = ?
    `).get(prevMonth).total;

    const budgets = db.prepare(`
      SELECT b.category, b.amount AS budget,
             COALESCE(SUM(ABS(t.amount)), 0) AS spent
      FROM budgets b
      LEFT JOIN transactions t
        ON lower(t.category) = lower(b.category)
        AND strftime('%Y-%m', t.date) = ?
        AND t.amount < 0
      WHERE b.amount > 0
      GROUP BY b.id
      ORDER BY (COALESCE(SUM(ABS(t.amount)), 0) * 1.0 / b.amount) DESC
      LIMIT 8
    `).all(month)
      .filter(b => b.spent > 0)
      .map(b => ({ category: b.category, budget: b.budget, spent: b.spent, pct: (b.spent / b.budget) * 100 }));

    const monthLabel = new Date(month + '-01T00:00:00')
      .toLocaleString('en-US', { month: 'long', year: 'numeric' });

    return {
      month,
      monthLabel,
      today: cal.today,
      spent,
      income,
      net,
      txCount: totals.txCount,
      savingsRate: income > 0 ? (net / income) * 100 : null,
      avgDaily: cal.daysInMonth > 0 ? spent / cal.daysInMonth : spent,
      prevSpent,
      spentDeltaPct: prevSpent > 0 ? ((spent - prevSpent) / prevSpent) * 100 : null,
      topCategories,
      topMerchants,
      biggestExpenses,
      budgets
    };
  },

  // Render + send the monthly report via Resend. The API key is read from the
  // environment (never committed) — see .env / GitHub Actions secrets. Throws
  // on any non-2xx so Temporal retries and surfaces the failure in its UI.
  async sendMonthlyReportEmail(report) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not set — add it to the environment');

    const from = process.env.REPORT_EMAIL_FROM || 'onboarding@resend.dev';
    const to   = process.env.REPORT_EMAIL_TO   || 'maruthi.phanikumar@yahoo.com';
    const subject = monthlyReportSubject(report);
    const html = monthlyReportHtml(report);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, html })
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Resend ${res.status}: ${text.slice(0, 300)}`);
    let id = null;
    try { id = JSON.parse(text).id || null; } catch (_) {}
    return { id, to, subject };
  }
});
