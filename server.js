require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'finance.db');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

const crypto = require('crypto');

// ─── DB INIT ──────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Migrate: add receipt_path column if it doesn't exist yet
try { db.prepare('ALTER TABLE transactions ADD COLUMN receipt_path TEXT').run(); } catch (_) {}
// Migrate: add role column to users (existing single user becomes admin)
try { db.prepare("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'").run(); } catch (_) {}

// Persist session secret in DB so it survives container restarts
let sessionSecret = db.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").get()?.value;
if (!sessionSecret) {
  sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('session_secret', ?)").run(sessionSecret);
}

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

// ─── RULES ENGINE ─────────────────────────────────────────────────────────────

function applyRules(txData) {
  const rules = db.prepare(
    'SELECT * FROM rules WHERE enabled = 1 ORDER BY priority DESC, id ASC'
  ).all();

  let category = txData.category || null;

  for (const rule of rules) {
    if (!matchRule(rule, txData)) continue;
    if (rule.action_type === 'set_category') category = rule.action_value;
  }

  return { category };
}

function matchRule(rule, tx) {
  const op  = rule.condition_op;
  const raw = rule.condition_value;

  if (rule.condition_field === 'amount') {
    const amt = parseFloat(tx.amount);
    const val = parseFloat(raw);
    if (isNaN(amt) || isNaN(val)) return false;
    if (op === 'gt')  return amt >  val;
    if (op === 'lt')  return amt <  val;
    if (op === 'gte') return amt >= val;
    if (op === 'lte') return amt <= val;
    if (op === 'eq')  return amt === val;
    return false;
  }

  const field = String(tx[rule.condition_field] || '').toLowerCase();
  const val   = raw.toLowerCase();
  if (op === 'contains')    return field.includes(val);
  if (op === 'equals')      return field === val;
  if (op === 'starts_with') return field.startsWith(val);
  if (op === 'ends_with')   return field.endsWith(val);
  return false;
}

// ─── MULTER ───────────────────────────────────────────────────────────────────

const upload = multer({ dest: path.join(__dirname, 'uploads') });

const receiptStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'receipts');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `receipt-${req.params.id}-${Date.now()}${ext}`);
  }
});
const receiptUpload = multer({
  storage: receiptStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const PUBLIC = new Set(['/login', '/setup', '/auth/login', '/auth/setup']);
  if (PUBLIC.has(req.path)) return next();

  // No users yet — force setup
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount === 0) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No accounts exist. Visit /setup' });
    return res.redirect('/setup');
  }

  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// Setup page — only when no users exist
app.get('/setup', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount > 0) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.post('/auth/setup', async (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount > 0) return res.redirect('/login');

  const { username, password, confirm } = req.body;
  if (!username?.trim() || !password) return res.redirect('/setup?error=missing');
  if (password !== confirm)            return res.redirect('/setup?error=mismatch');
  if (password.length < 8)            return res.redirect('/setup?error=short');

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username.trim(), hash);
  req.session.user = { id: result.lastInsertRowid, username: username.trim(), role: 'admin' };
  res.redirect('/');
});

// Login page
app.get('/login', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount === 0) return res.redirect('/setup');
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username?.trim());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.redirect('/login?error=1');
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.post('/auth/change-password', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { current, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !(await bcrypt.compare(current, user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.user) return res.json({ username: null, role: null });
  const user = db.prepare('SELECT username, role FROM users WHERE id = ?').get(req.session.user.id);
  res.json({ username: user?.username || null, role: user?.role || null });
});

// ─── INVITE (public — before requireAuth) ─────────────────────────────────────

app.get('/invite/:token', (req, res) => {
  const invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!invite || new Date(invite.expires_at) < new Date()) {
    return res.status(410).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invalid Invite</title>
      <style>body{background:#0f1117;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
      .card{background:#1a1d27;border:1px solid #2e3350;border-radius:14px;padding:40px;max-width:360px}
      h2{color:#f87171;margin-bottom:12px}p{color:#8892a4;margin-bottom:20px}
      a{color:#6c8ef5}</style></head>
      <body><div class="card"><h2>Invite Expired</h2><p>This invite link is no longer valid. Ask the account admin to generate a new one.</p><a href="/login">Sign in</a></div></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

app.post('/auth/invite', async (req, res) => {
  const { token, username, password, confirm } = req.body;
  const invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(token);
  if (!invite || new Date(invite.expires_at) < new Date()) {
    return res.redirect(`/invite/${token}?error=expired`);
  }
  if (!username?.trim() || !password) return res.redirect(`/invite/${encodeURIComponent(token)}?error=missing`);
  if (password !== confirm)            return res.redirect(`/invite/${encodeURIComponent(token)}?error=mismatch`);
  if (password.length < 8)            return res.redirect(`/invite/${encodeURIComponent(token)}?error=short`);
  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
  if (existing) return res.redirect(`/invite/${encodeURIComponent(token)}?error=exists`);

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'member')").run(username.trim(), hash);
  db.prepare('DELETE FROM invites WHERE token = ?').run(token);
  req.session.user = { id: result.lastInsertRowid, username: username.trim(), role: 'member' };
  res.redirect('/');
});

// Protect everything below this line
app.use(requireAuth);

// Static files (now auth-gated)
app.use(express.static(path.join(__dirname, 'public')));

// Serve receipt images (auth-gated)
app.use('/receipts', express.static(path.join(__dirname, 'uploads', 'receipts')));

// ─── USER MANAGEMENT (admin only) ────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session?.user?.id);
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all();
  res.json(users);
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.session.user.id) return res.status(400).json({ error: "You can't remove your own account" });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetId)) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ ok: true });
});

app.post('/api/invites', requireAdmin, (req, res) => {
  // Clean up expired tokens first
  db.prepare("DELETE FROM invites WHERE expires_at < datetime('now')").run();
  const token     = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invites (token, created_by, expires_at) VALUES (?, ?, ?)').run(token, req.session.user.id, expiresAt);
  const url = `${req.protocol}://${req.get('host')}/invite/${token}`;
  res.json({ url, expires_at: expiresAt });
});

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
  const resolved = applyRules({ payee, amount: parseFloat(amount), notes, category });
  const result = db.prepare(
    'INSERT INTO transactions (date, payee, category, amount, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(date, payee, resolved.category, parseFloat(amount), notes || null);
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

// ─── RECEIPTS ─────────────────────────────────────────────────────────────────

app.post('/api/transactions/:id/receipt', receiptUpload.single('receipt'), (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No valid file uploaded (jpg/png/webp/pdf, max 10 MB)' });

  // Remove old receipt file if one existed
  if (tx.receipt_path) {
    fs.unlink(path.join(__dirname, 'uploads', 'receipts', tx.receipt_path), () => {});
  }

  db.prepare('UPDATE transactions SET receipt_path = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ receipt_path: req.file.filename });
});

app.delete('/api/transactions/:id/receipt', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.receipt_path) {
    fs.unlink(path.join(__dirname, 'uploads', 'receipts', tx.receipt_path), () => {});
    db.prepare('UPDATE transactions SET receipt_path = NULL WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

// ─── BUDGETS ──────────────────────────────────────────────────────────────────

app.get('/api/budgets', (req, res) => {
  res.json(db.prepare('SELECT * FROM budgets ORDER BY category COLLATE NOCASE').all());
});

// Budget status: each category's budget vs actual spending for a given month
app.get('/api/budgets/status', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT
      b.id, b.category, b.amount AS budget,
      COALESCE(SUM(ABS(t.amount)), 0) AS spent
    FROM budgets b
    LEFT JOIN transactions t
      ON lower(t.category) = lower(b.category)
      AND strftime('%Y-%m', t.date) = ?
      AND t.amount < 0
    GROUP BY b.id
    ORDER BY b.category COLLATE NOCASE
  `).all(month);
  res.json(rows);
});

app.post('/api/budgets', (req, res) => {
  const { category, amount } = req.body;
  if (!category?.trim() || !amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'category and a positive amount are required' });
  }
  db.prepare(`
    INSERT INTO budgets (category, amount)
    VALUES (?, ?)
    ON CONFLICT(category) DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')
  `).run(category.trim(), parseFloat(amount));
  res.json(db.prepare('SELECT * FROM budgets WHERE category = ? COLLATE NOCASE').get(category.trim()));
});

app.delete('/api/budgets/:id', (req, res) => {
  const result = db.prepare('DELETE FROM budgets WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ─── CATEGORIES ───────────────────────────────────────────────────────────────

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

// ─── YEAR IN REVIEW ───────────────────────────────────────────────────────────

app.get('/api/year-review/:year', (req, res) => {
  const year = req.params.year;
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'Invalid year' });

  const summary = db.prepare(`
    SELECT
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)        AS total_income,
      ABS(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END))   AS total_expenses,
      SUM(amount)                                              AS net,
      COUNT(*)                                                 AS tx_count
    FROM transactions
    WHERE strftime('%Y', date) = ?
  `).get(year);

  const monthly = db.prepare(`
    SELECT
      strftime('%m', date)                                        AS month,
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)           AS income,
      ABS(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END))      AS expenses
    FROM transactions
    WHERE strftime('%Y', date) = ?
    GROUP BY month
    ORDER BY month
  `).all(year);

  const categories = db.prepare(`
    SELECT
      COALESCE(category, 'Uncategorized') AS category,
      SUM(ABS(amount))                    AS total,
      COUNT(*)                            AS count
    FROM transactions
    WHERE strftime('%Y', date) = ? AND amount < 0
    GROUP BY category
    ORDER BY total DESC
    LIMIT 10
  `).all(year);

  const top_expenses = db.prepare(`
    SELECT id, date, payee, category, amount, notes
    FROM transactions
    WHERE strftime('%Y', date) = ? AND amount < 0
    ORDER BY amount ASC
    LIMIT 5
  `).all(year);

  const available_years = db.prepare(`
    SELECT DISTINCT strftime('%Y', date) AS year
    FROM transactions
    ORDER BY year DESC
  `).all().map(r => r.year);

  res.json({
    year,
    summary: {
      total_income:   summary.total_income   || 0,
      total_expenses: summary.total_expenses || 0,
      net:            summary.net            || 0,
      tx_count:       summary.tx_count       || 0
    },
    monthly,
    categories,
    top_expenses,
    available_years
  });
});

// ─── RULES CRUD ───────────────────────────────────────────────────────────────

const VALID_FIELDS = new Set(['payee', 'notes', 'amount']);
const VALID_OPS    = new Set(['contains', 'equals', 'starts_with', 'ends_with', 'gt', 'lt', 'gte', 'lte', 'eq']);
const VALID_ACTIONS = new Set(['set_category']);

app.get('/api/rules', (req, res) => {
  res.json(db.prepare('SELECT * FROM rules ORDER BY priority DESC, id ASC').all());
});

app.post('/api/rules', (req, res) => {
  const { name, condition_field, condition_op, condition_value, action_type, action_value, priority = 0 } = req.body;
  if (!name?.trim() || !condition_field || !condition_op || !condition_value?.trim() || !action_type || !action_value?.trim()) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!VALID_FIELDS.has(condition_field))  return res.status(400).json({ error: 'Invalid condition field' });
  if (!VALID_OPS.has(condition_op))        return res.status(400).json({ error: 'Invalid condition operator' });
  if (!VALID_ACTIONS.has(action_type))     return res.status(400).json({ error: 'Invalid action type' });

  const result = db.prepare(
    'INSERT INTO rules (name, condition_field, condition_op, condition_value, action_type, action_value, priority) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), condition_field, condition_op, condition_value.trim(), action_type, action_value.trim(), parseInt(priority) || 0);
  res.json(db.prepare('SELECT * FROM rules WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/rules/:id', (req, res) => {
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  const { name, condition_field, condition_op, condition_value, action_type, action_value, priority, enabled } = req.body;
  db.prepare(`UPDATE rules SET name=?, condition_field=?, condition_op=?, condition_value=?,
    action_type=?, action_value=?, priority=?, enabled=? WHERE id=?`).run(
    name ?? rule.name, condition_field ?? rule.condition_field,
    condition_op ?? rule.condition_op, condition_value ?? rule.condition_value,
    action_type ?? rule.action_type, action_value ?? rule.action_value,
    priority !== undefined ? parseInt(priority) : rule.priority,
    enabled !== undefined ? (enabled ? 1 : 0) : rule.enabled,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id));
});

app.delete('/api/rules/:id', (req, res) => {
  const result = db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Apply all enabled rules to every existing transaction
app.post('/api/rules/apply', (req, res) => {
  const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY priority DESC, id ASC').all();
  if (!rules.length) return res.json({ updated: 0 });

  const txs    = db.prepare('SELECT * FROM transactions').all();
  const update = db.prepare("UPDATE transactions SET category=?, updated_at=datetime('now') WHERE id=?");
  let updated  = 0;

  db.transaction(() => {
    for (const tx of txs) {
      const resolved = applyRules({ payee: tx.payee, amount: tx.amount, notes: tx.notes, category: tx.category });
      if (resolved.category !== tx.category) {
        update.run(resolved.category, tx.id);
        updated++;
      }
    }
  })();

  res.json({ updated });
});

// ─── EXPORT ───────────────────────────────────────────────────────────────────

app.get('/api/export/csv', (req, res) => {
  const { month } = req.query;
  let rows;
  if (month) {
    rows = db.prepare(
      "SELECT date, payee, category, amount, notes FROM transactions WHERE strftime('%Y-%m', date) = ? ORDER BY date DESC"
    ).all(month);
  } else {
    rows = db.prepare(
      'SELECT date, payee, category, amount, notes FROM transactions ORDER BY date DESC'
    ).all();
  }

  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = 'Date,Payee,Category,Amount,Notes';
  const lines  = rows.map(r => [r.date, r.payee, r.category, r.amount, r.notes].map(escape).join(','));
  const csv    = [header, ...lines].join('\r\n');

  const filename = month ? `transactions-${month}.csv` : 'transactions-all.csv';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
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

        const resolved = applyRules({ payee, amount, notes, category });
        insertStmt.run(isoDate, payee, resolved.category, amount, notes, 'import');
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
