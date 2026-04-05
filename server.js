const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'finance.db');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

// Init DB
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Seed categories table from existing transaction data (runs once for existing DBs)
db.prepare(`
  INSERT OR IGNORE INTO categories (name)
  SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL AND category != ''
`).run();

// Fix income transactions stored as 'Unknown' payee — use category instead
db.prepare(`
  UPDATE transactions
  SET payee = COALESCE(NULLIF(category, ''), 'Income')
  WHERE amount > 0
    AND (payee = 'Unknown' OR payee = '' OR payee IS NULL)
`).run();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'uploads') });

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────

app.get('/api/transactions', (req, res) => {
  const { month, payee, category, search, limit = 200, offset = 0 } = req.query;
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (month) {
    sql += ' AND strftime(\'%Y-%m\', date) = ?';
    params.push(month);
  }
  if (payee) {
    sql += ' AND lower(payee) LIKE ?';
    params.push(`%${payee.toLowerCase()}%`);
  }
  if (category) {
    sql += ' AND lower(category) LIKE ?';
    params.push(`%${category.toLowerCase()}%`);
  }
  if (search) {
    sql += ' AND (lower(payee) LIKE ? OR lower(notes) LIKE ? OR lower(category) LIKE ?)';
    const s = `%${search.toLowerCase()}%`;
    params.push(s, s, s);
  }

  sql += ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const rows = db.prepare(sql).all(...params);
  const total = db.prepare(
    'SELECT COUNT(*) as cnt FROM transactions WHERE 1=1' +
    (month ? ' AND strftime(\'%Y-%m\', date) = ?' : '') +
    (payee ? ' AND lower(payee) LIKE ?' : '') +
    (category ? ' AND lower(category) LIKE ?' : '') +
    (search ? ' AND (lower(payee) LIKE ? OR lower(notes) LIKE ? OR lower(category) LIKE ?)' : '')
  ).get(...params.slice(0, -2));

  res.json({ rows, total: total.cnt });
});

app.post('/api/transactions', (req, res) => {
  const { date, payee, category, amount, notes } = req.body;
  if (!date || !payee || amount === undefined) {
    return res.status(400).json({ error: 'date, payee, and amount are required' });
  }
  const result = db.prepare(
    'INSERT INTO transactions (date, payee, category, amount, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(date, payee, category || null, parseFloat(amount), notes || null);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/transactions/:id', (req, res) => {
  const { date, payee, category, amount, notes } = req.body;
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE transactions SET
      date = ?, payee = ?, category = ?, amount = ?, notes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    date ?? existing.date,
    payee ?? existing.payee,
    category !== undefined ? category : existing.category,
    amount !== undefined ? parseFloat(amount) : existing.amount,
    notes !== undefined ? notes : existing.notes,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
});

app.delete('/api/transactions/:id', (req, res) => {
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.get('/api/transactions/summary', (req, res) => {
  const { month } = req.query;
  const where = month ? 'WHERE strftime(\'%Y-%m\', date) = ?' : '';
  const params = month ? [month] : [];

  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) as expenses,
      SUM(amount) as net
    FROM transactions ${where}
  `).get(...params);

  res.json({
    income: row.income || 0,
    expenses: row.expenses || 0,
    net: row.net || 0
  });
});

app.get('/api/transactions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT name FROM categories ORDER BY name COLLATE NOCASE').all();
  res.json(rows.map(r => r.name));
});

app.post('/api/categories', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
  try {
    db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Category already exists' });
    throw e;
  }
});

app.delete('/api/categories/:name', (req, res) => {
  db.prepare('DELETE FROM categories WHERE name = ? COLLATE NOCASE').run(req.params.name);
  res.json({ ok: true });
});

app.get('/api/payees', (req, res) => {
  const rows = db.prepare(
    'SELECT DISTINCT payee FROM transactions ORDER BY payee'
  ).all();
  res.json(rows.map(r => r.payee));
});

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

app.get('/api/subscriptions', (req, res) => {
  const { active } = req.query;
  let sql = 'SELECT * FROM subscriptions';
  const params = [];
  if (active !== undefined) {
    sql += ' WHERE active = ?';
    params.push(parseInt(active));
  }
  sql += ' ORDER BY next_due_date ASC';
  res.json(db.prepare(sql).all(...params));
});

// Detect subscriptions from transactions tagged with subscription-like categories
app.get('/api/subscriptions/detect', (req, res) => {
  // Find all unique payees from transactions where category contains 'subscription'
  const detected = db.prepare(`
    SELECT
      payee,
      category,
      AVG(ABS(amount))                          AS avg_amount,
      MAX(date)                                 AS last_date,
      COUNT(DISTINCT strftime('%Y-%m', date))   AS months_seen,
      COUNT(*)                                  AS total_txns
    FROM transactions
    WHERE amount < 0
      AND lower(category) LIKE '%subscription%'
    GROUP BY lower(payee)
    ORDER BY avg_amount DESC
  `).all();

  // Filter out payees already tracked in subscriptions table
  const tracked = new Set(
    db.prepare('SELECT lower(name) as n FROM subscriptions').all().map(r => r.n)
  );
  const trackedPayees = new Set(
    db.prepare('SELECT lower(payee) as p FROM subscriptions WHERE payee IS NOT NULL').all().map(r => r.p)
  );

  const suggestions = detected.filter(
    r => !tracked.has(r.payee.toLowerCase()) && !trackedPayees.has(r.payee.toLowerCase())
  );

  res.json(suggestions);
});

app.get('/api/subscriptions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/subscriptions', (req, res) => {
  const { name, amount, billing_cycle, next_due_date, category, payee, notes } = req.body;
  if (!name || amount === undefined || !billing_cycle || !next_due_date) {
    return res.status(400).json({ error: 'name, amount, billing_cycle, next_due_date are required' });
  }
  const result = db.prepare(`
    INSERT INTO subscriptions (name, amount, billing_cycle, next_due_date, category, payee, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, parseFloat(amount), billing_cycle, next_due_date, category || null, payee || null, notes || null);
  res.json(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/subscriptions/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const fields = ['name', 'amount', 'billing_cycle', 'next_due_date', 'category', 'payee', 'notes', 'active'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (updates.amount) updates.amount = parseFloat(updates.amount);
  if (updates.active !== undefined) updates.active = parseInt(updates.active);

  if (Object.keys(updates).length === 0) return res.json(existing);
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE subscriptions SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id));
});

app.delete('/api/subscriptions/:id', (req, res) => {
  const result = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ─── REMINDERS ────────────────────────────────────────────────────────────────

app.get('/api/reminders', (req, res) => {
  const { paid, upcoming_days } = req.query;
  let sql = 'SELECT * FROM reminders WHERE 1=1';
  const params = [];

  if (paid !== undefined) {
    sql += ' AND paid = ?';
    params.push(parseInt(paid));
  }
  if (upcoming_days) {
    sql += ' AND due_date <= date(\'now\', ? || \' days\')';
    params.push(`+${upcoming_days}`);
  }
  sql += ' ORDER BY due_date ASC';
  res.json(db.prepare(sql).all(...params));
});

// Detect bill reminders from previous month's transactions
app.get('/api/reminders/detect', (req, res) => {
  // Bill-like category keywords — things you have to pay, not things you choose to buy
  const BILL_KEYWORDS = [
    'utility', 'utilities', 'electric', 'electricity', 'gas', 'natural gas',
    'water', 'sewer', 'trash', 'internet', 'cable', 'broadband', 'fiber',
    'phone', 'mobile', 'wireless', 'cell', 'telephone', 'landline',
    'insurance', 'mortgage', 'rent', 'hoa', 'homeowner', 'association',
    'loan', 'auto loan', 'student loan', 'car payment',
    'bill', 'bills', 'subscription', 'streaming', 'dues', 'fee', 'fees'
  ];

  const conditions = BILL_KEYWORDS.map(() => "lower(category) LIKE ?").join(' OR ');
  const likeParams = BILL_KEYWORDS.map(k => `%${k}%`);

  // Previous month in YYYY-MM format
  const today = new Date();
  const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevMonthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
  const currentMonthStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  const rows = db.prepare(`
    SELECT
      payee,
      category,
      ABS(AVG(amount))                        AS avg_amount,
      MAX(date)                               AS last_date,
      CAST(strftime('%d', MAX(date)) AS INT)  AS day_of_month
    FROM transactions
    WHERE amount < 0
      AND strftime('%Y-%m', date) = ?
      AND (${conditions})
    GROUP BY lower(payee)
    ORDER BY avg_amount DESC
  `).all(prevMonthStr, ...likeParams);

  // Get existing unpaid reminder titles to avoid duplicates
  const existingTitles = new Set(
    db.prepare("SELECT lower(title) as t FROM reminders WHERE paid = 0").all().map(r => r.t)
  );

  const suggestions = rows
    .filter(r => !existingTitles.has(r.payee.toLowerCase()))
    .map(r => {
      // Project due date: same day of month in current month
      const dom = Math.min(r.day_of_month, 28); // cap at 28 for Feb safety
      const dueDate = `${currentMonthStr}-${String(dom).padStart(2, '0')}`;
      return {
        payee: r.payee,
        category: r.category,
        avg_amount: parseFloat(r.avg_amount.toFixed(2)),
        last_date: r.last_date,
        suggested_due: dueDate
      };
    });

  res.json({ suggestions, prev_month: prevMonthStr });
});

app.get('/api/reminders/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/reminders', (req, res) => {
  const { title, due_date, amount, category, recurring, recur_days, notes } = req.body;
  if (!title || !due_date) return res.status(400).json({ error: 'title and due_date are required' });
  const result = db.prepare(`
    INSERT INTO reminders (title, due_date, amount, category, recurring, recur_days, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, due_date, amount || null, category || null, recurring ? 1 : 0, recur_days || null, notes || null);
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/reminders/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const fields = ['title', 'due_date', 'amount', 'category', 'recurring', 'recur_days', 'paid', 'paid_date', 'notes'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE reminders SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id));
});

app.delete('/api/reminders/:id', (req, res) => {
  const result = db.prepare('DELETE FROM reminders WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/reminders/:id/pay', (req, res) => {
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
  if (!reminder) return res.status(404).json({ error: 'Not found' });

  const today = new Date().toISOString().split('T')[0];
  db.prepare('UPDATE reminders SET paid = 1, paid_date = ? WHERE id = ?').run(today, reminder.id);

  let next = null;
  if (reminder.recurring && reminder.recur_days) {
    const nextDate = new Date(today);
    nextDate.setDate(nextDate.getDate() + reminder.recur_days);
    const nextDue = nextDate.toISOString().split('T')[0];
    const r = db.prepare(`
      INSERT INTO reminders (title, due_date, amount, category, recurring, recur_days, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reminder.title, nextDue, reminder.amount, reminder.category, 1, reminder.recur_days, reminder.notes);
    next = db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.lastInsertRowid);
  }

  res.json({
    paid: db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminder.id),
    next
  });
});

// ─── CHARTS ───────────────────────────────────────────────────────────────────

app.get('/api/charts/monthly-by-payee', (req, res) => {
  const { month } = req.query;
  const where = month ? 'WHERE strftime(\'%Y-%m\', date) = ? AND amount < 0' : 'WHERE amount < 0';
  const params = month ? [month] : [];
  const rows = db.prepare(`
    SELECT payee, SUM(amount) as total, COUNT(*) as count
    FROM transactions ${where}
    GROUP BY payee ORDER BY total ASC LIMIT 20
  `).all(...params);
  res.json(rows);
});

app.get('/api/charts/spending-trend', (req, res) => {
  const months = parseInt(req.query.months) || 6;
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income
    FROM transactions
    WHERE date >= date('now', ? || ' months')
    GROUP BY month ORDER BY month ASC
  `).all(`-${months}`);
  res.json(rows);
});

app.get('/api/charts/category-breakdown', (req, res) => {
  const { month } = req.query;
  const where = month
    ? 'WHERE strftime(\'%Y-%m\', date) = ? AND amount < 0'
    : 'WHERE amount < 0';
  const params = month ? [month] : [];
  const rows = db.prepare(`
    SELECT COALESCE(category, 'Uncategorized') as category,
           SUM(ABS(amount)) as total, COUNT(*) as count
    FROM transactions ${where}
    GROUP BY category ORDER BY total DESC
  `).all(...params);
  res.json(rows);
});

app.get('/api/charts/available-months', (req, res) => {
  const rows = db.prepare(
    'SELECT DISTINCT strftime(\'%Y-%m\', date) as month FROM transactions ORDER BY month DESC'
  ).all();
  res.json(rows.map(r => r.month));
});

// ─── IMPORT ───────────────────────────────────────────────────────────────────

app.post('/api/import/csv', upload.single('csvfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let content;
  try {
    content = fs.readFileSync(req.file.path, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Could not read file' });
  } finally {
    fs.unlink(req.file.path, () => {});
  }

  let records;
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid CSV: ' + e.message });
  }

  if (records.length === 0) return res.json({ imported: 0, skipped: 0, errors: [] });

  // Auto-detect column names (case-insensitive)
  const colMap = {};
  const firstRow = records[0];
  Object.keys(firstRow).forEach(col => {
    const lower = col.toLowerCase().trim();
    if (lower === 'date' || lower === 'transaction date') colMap.date = col;
    else if (lower === 'payee' || lower === 'description' || lower === 'merchant') colMap.payee = col;
    else if (lower === 'category') colMap.category = col;
    else if (lower === 'amount' || lower === 'transaction amount') colMap.amount = col;
    else if (lower === 'notes' || lower === 'memo' || lower === 'note') colMap.notes = col;
  });

  if (!colMap.date || !colMap.amount) {
    return res.status(400).json({ error: 'CSV must have Date and Amount columns' });
  }

  let imported = 0, skipped = 0;
  const errors = [];

  const insertStmt = db.prepare(
    'INSERT INTO transactions (date, payee, category, amount, notes, source) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const checkStmt = db.prepare(
    'SELECT 1 FROM transactions WHERE date = ? AND payee = ? AND amount = ? AND source = ?'
  );

  const doImport = db.transaction(() => {
    records.forEach((row, i) => {
      try {
        // Parse date — handle MM/DD/YYYY and YYYY-MM-DD
        let rawDate = row[colMap.date];
        let isoDate;
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawDate)) {
          const [m, d, y] = rawDate.split('/');
          isoDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
          isoDate = rawDate;
        } else {
          // Try Date.parse as fallback
          const parsed = new Date(rawDate);
          if (isNaN(parsed)) throw new Error(`Unrecognized date: ${rawDate}`);
          isoDate = parsed.toISOString().split('T')[0];
        }

        const rawAmount = row[colMap.amount].replace(/[$,\s]/g, '');
        const amount = parseFloat(rawAmount);
        if (isNaN(amount)) throw new Error(`Invalid amount: ${row[colMap.amount]}`);

        const category = colMap.category ? (row[colMap.category] || null) : null;

        // For income (positive) with no payee, use category name or 'Income'
        // For expenses with no payee, fall back to 'Unknown'
        const rawPayee = colMap.payee ? row[colMap.payee] : '';
        const payee = rawPayee ||
          (amount > 0 ? (category || 'Income') : 'Unknown');
        const notes = colMap.notes ? (row[colMap.notes] || null) : null;

        const exists = checkStmt.get(isoDate, payee, amount, 'import');
        if (exists) { skipped++; return; }

        insertStmt.run(isoDate, payee, category, amount, notes, 'import');
        imported++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
      }
    });
  });

  try {
    doImport();
    res.json({ imported, skipped, errors });
  } catch (e) {
    res.status(500).json({ error: 'Import failed: ' + e.message });
  }
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────

const today = new Date().toISOString().split('T')[0];
const overdue = db.prepare(
  'SELECT COUNT(*) as cnt FROM reminders WHERE paid = 0 AND due_date < ?'
).get(today);
if (overdue.cnt > 0) {
  console.log(`⚠️  You have ${overdue.cnt} overdue bill reminder(s)!`);
}

app.listen(PORT, () => {
  console.log(`Home Finance running at http://localhost:${PORT}`);
});
