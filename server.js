require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const { createWorker } = require('tesseract.js');

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
// Migrate: add display_name column to users
try { db.prepare('ALTER TABLE users ADD COLUMN display_name TEXT').run(); } catch (_) {}

// Persist session secret in DB so it survives container restarts
let sessionSecret = db.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").get()?.value;
if (!sessionSecret) {
  sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('session_secret', ?)").run(sessionSecret);
}

// ─── WEB PUSH (VAPID auto-generated and persisted on first boot) ──────────────
let vapidPublic  = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid_public'").get()?.value;
let vapidPrivate = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid_private'").get()?.value;
if (!vapidPublic || !vapidPrivate) {
  const keys = webpush.generateVAPIDKeys();
  vapidPublic  = keys.publicKey;
  vapidPrivate = keys.privateKey;
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('vapid_public', ?)").run(vapidPublic);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('vapid_private', ?)").run(vapidPrivate);
  console.log('Generated new VAPID keypair for Web Push.');
}
// Apple's APNs is strict about the VAPID `sub` claim — it rejects `.local`
// TLDs and any obviously fake-looking subject. example.com is RFC-reserved
// and universally accepted.
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  vapidPublic,
  vapidPrivate
);

// Send a push payload to every saved subscription. Cleans up dead endpoints
// and returns per-endpoint error details so failures are debuggable.
async function sendPushToAll(payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (subs.length === 0) return { sent: 0, failed: 0, errors: [] };
  let sent = 0, failed = 0;
  const errors = [];
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      db.prepare('UPDATE push_subscriptions SET last_seen = datetime(\'now\') WHERE id = ?').run(s.id);
      sent++;
    } catch (err) {
      const code = err.statusCode;
      const body = err.body || err.message || String(err);
      const host = (() => { try { return new URL(s.endpoint).host; } catch (_) { return 'unknown'; } })();
      console.error(`[web-push] FAIL host=${host} code=${code} body=${body}`);
      if (code === 404 || code === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      }
      errors.push({ host, statusCode: code || null, body: String(body).slice(0, 300) });
      failed++;
    }
  }));
  return { sent, failed, errors };
}
// Send a push to every subscription EXCEPT one (used to avoid notifying the
// device that just performed the action). Pass null/undefined to send to all.
async function sendPushExcept(excludeEndpoint, payload) {
  const subs = excludeEndpoint
    ? db.prepare('SELECT * FROM push_subscriptions WHERE endpoint != ?').all(excludeEndpoint)
    : db.prepare('SELECT * FROM push_subscriptions').all();
  if (subs.length === 0) return { sent: 0, failed: 0, errors: [] };
  let sent = 0, failed = 0;
  const errors = [];
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      db.prepare('UPDATE push_subscriptions SET last_seen = datetime(\'now\') WHERE id = ?').run(s.id);
      sent++;
    } catch (err) {
      const code = err.statusCode;
      if (code === 404 || code === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      }
      errors.push({ statusCode: code, body: String(err.body || err.message).slice(0, 200) });
      failed++;
    }
  }));
  return { sent, failed, errors };
}

module.exports.sendPushToAll = sendPushToAll;
module.exports.sendPushExcept = sendPushExcept;
module.exports.db = db;

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

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

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
  if (!req.session?.user) return res.json({ username: null, role: null, display_name: null });
  const user = db.prepare('SELECT username, role, display_name FROM users WHERE id = ?').get(req.session.user.id);
  res.json({
    username: user?.username || null,
    role: user?.role || null,
    display_name: user?.display_name || null
  });
});

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidPublic });
});

app.post('/api/push/subscribe', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      last_seen = datetime('now')
  `).run(req.session.user.id, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

app.get('/api/push/status', (req, res) => {
  if (!req.session?.user) return res.json({ count: 0 });
  const row = db.prepare('SELECT COUNT(*) as cnt FROM push_subscriptions WHERE user_id = ?').get(req.session.user.id);
  res.json({ count: row.cnt });
});

// Manual trigger for testing — sends a "ping" notification to all subscribers.
app.post('/api/push/test', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const result = await sendPushToAll({
    title: '🔔 Test Notification',
    body: 'Web Push is working. You\'ll get these for bills, insights, and alerts.',
    tag: 'test',
    data: { route: '#/dashboard' }
  });
  res.json(result);
});

app.post('/auth/profile', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const name = String(req.body.display_name || '').trim();
  if (name.length > 60) return res.status(400).json({ error: 'Display name too long (max 60 chars)' });
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name || null, req.session.user.id);
  res.json({ ok: true, display_name: name || null });
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
  const { month, year, date, payee, category, search, limit = 200, offset = 0 } = req.query;

  // Build WHERE clause once, reuse for SELECT and COUNT
  const conditions = [];
  const whereParams = [];
  if (date)     { conditions.push("date = ?");                   whereParams.push(date); }
  if (month)    { conditions.push("strftime('%Y-%m', date) = ?"); whereParams.push(month); }
  if (year)     { conditions.push("strftime('%Y', date) = ?");    whereParams.push(year);  }
  if (payee)    { conditions.push("lower(payee) LIKE ?");          whereParams.push(`%${payee.toLowerCase()}%`); }
  if (category) { conditions.push("lower(category) LIKE ?");       whereParams.push(`%${category.toLowerCase()}%`); }
  if (search)   {
    conditions.push("(lower(payee) LIKE ? OR lower(notes) LIKE ? OR lower(category) LIKE ?)");
    const s = `%${search.toLowerCase()}%`;
    whereParams.push(s, s, s);
  }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(
    'SELECT * FROM transactions' + where + ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?'
  ).all(...whereParams, parseInt(limit), parseInt(offset));
  const total = db.prepare('SELECT COUNT(*) as cnt FROM transactions' + where).get(...whereParams);

  res.json({ rows, total: total.cnt });
});

app.post('/api/transactions', (req, res) => {
  const { date, payee, category, amount, notes } = req.body;
  if (!date || !payee || amount === undefined) {
    return res.status(400).json({ error: 'date, payee, and amount are required' });
  }
  const amt = parseFloat(amount);
  const resolved = applyRules({ payee, amount: amt, notes, category });
  const result = db.prepare(
    'INSERT INTO transactions (date, payee, category, amount, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(date, payee, resolved.category, amt, notes || null);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);

  // Notify other devices in the household (excluding the originator)
  const myEndpoint = req.get('X-Push-Endpoint') || null;
  const me = req.session?.user;
  const actor = me ? (db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(me.id) || {}) : {};
  const actorName = (actor.display_name || actor.username || 'Someone');
  const signedAmt = amt < 0 ? `-$${Math.abs(amt).toFixed(2)}` : `+$${amt.toFixed(2)}`;
  sendPushExcept(myEndpoint, {
    title: `💸 ${actorName} added a transaction`,
    body: `${row.payee} · ${signedAmt}${row.category ? ` · ${row.category}` : ''}`,
    // Unique tag per transaction so multiple notifications don't silently replace each other
    tag: `tx-added-${row.id}`,
    data: { route: '#/transactions', txId: row.id }
  }).catch(err => console.error('[push] tx-added failed:', err));

  res.json(row);
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
  const tx = db.prepare('SELECT receipt_path FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.receipt_path) {
    fs.unlink(path.join(__dirname, 'uploads', 'receipts', tx.receipt_path), () => {});
  }
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
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

// ─── RECEIPT OCR (Tesseract.js — local, no cloud, no LLM) ─────────────────────
// Lazily-warmed worker so the first request pays the ~10s init cost but
// every subsequent call is fast.
let __ocrWorker = null;
let __ocrWorkerPromise = null;
async function getOcrWorker() {
  if (__ocrWorker) return __ocrWorker;
  if (!__ocrWorkerPromise) {
    __ocrWorkerPromise = createWorker('eng').then(w => { __ocrWorker = w; return w; });
  }
  return __ocrWorkerPromise;
}

// Extract a payee and amount from raw OCR text via simple heuristics.
function parseReceiptText(text) {
  if (!text) return { payee: null, amount: null };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Payee: first non-noisy line in the top of the receipt
  let payee = null;
  for (const line of lines.slice(0, 8)) {
    if (/^\d+[\d\s\-()]+$/.test(line))    continue;   // phone numbers
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line)) continue;   // dates
    if (line.length < 3 || line.length > 60) continue;
    const cleaned = line.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &'.\-]/g, '').trim();
    if (cleaned.length >= 3 && /[a-zA-Z]/.test(cleaned)) {
      payee = cleaned.slice(0, 40);
      break;
    }
  }

  // Amount: prefer explicit TOTAL/BALANCE/AMOUNT DUE lines
  let amount = null;
  const patterns = [
    /(?:GRAND\s+)?TOTAL[\s:]*\$?\s*(\d+\.\d{2})\b/im,
    /(?:BALANCE\s+DUE|AMOUNT\s+DUE|AMT\s+DUE)[\s:]*\$?\s*(\d+\.\d{2})\b/im,
    /(?:PAYMENT|CHARGED)[\s:]*\$?\s*(\d+\.\d{2})\b/im
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) { amount = parseFloat(m[1]); break; }
  }
  // Fallback: largest reasonable dollar amount on the receipt
  if (!amount) {
    const candidates = (text.match(/\$?\s*\d+\.\d{2}/g) || [])
      .map(s => parseFloat(s.replace(/[$,\s]/g, '')))
      .filter(n => !isNaN(n) && n > 0 && n < 100000);
    if (candidates.length) amount = Math.max(...candidates);
  }
  return { payee, amount };
}

const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

app.post('/api/receipts/ocr', ocrUpload.single('receipt'), async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.file)          return res.status(400).json({ error: 'Send an image as multipart field "receipt"' });
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(req.file.buffer);
    const { payee, amount } = parseReceiptText(data?.text || '');
    res.json({ payee, amount, confidence: Math.round(data?.confidence || 0) });
  } catch (err) {
    console.error('[ocr] failed:', err);
    res.status(500).json({ error: 'OCR failed: ' + (err.message || 'unknown') });
  }
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

// Suggest the most-used category for a given payee (last 12 months)
app.get('/api/payees/suggest-category', (req, res) => {
  const payee = String(req.query.payee || '').trim();
  if (!payee) return res.json({ category: null, count: 0 });

  const row = db.prepare(`
    SELECT category, COUNT(*) as cnt
    FROM transactions
    WHERE lower(payee) = lower(?)
      AND category IS NOT NULL
      AND category != ''
      AND date >= date('now', '-12 months')
    GROUP BY category
    ORDER BY cnt DESC, MAX(date) DESC
    LIMIT 1
  `).get(payee);

  res.json({ category: row?.category || null, count: row?.cnt || 0 });
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
// Detect price hikes — for each active subscription, compare the most recent
// matching transaction amount to the stored expected amount.
app.get('/api/subscriptions/price-alerts', (req, res) => {
  const subs = db.prepare('SELECT * FROM subscriptions WHERE active = 1').all();
  const alerts = [];

  for (const s of subs) {
    const matchName = (s.payee && s.payee.trim()) || s.name;
    if (!matchName) continue;

    // Find the two most recent matching expense transactions
    const txs = db.prepare(`
      SELECT amount, date FROM transactions
      WHERE amount < 0
        AND lower(payee) = lower(?)
        AND date >= date('now', '-90 days')
      ORDER BY date DESC
      LIMIT 2
    `).all(matchName);

    if (!txs.length) continue;

    const latest    = Math.abs(txs[0].amount);
    const expected  = Math.abs(s.amount);
    const previous  = txs[1] ? Math.abs(txs[1].amount) : expected;
    const baseline  = Math.max(expected, previous);

    // Flag if the latest charge is meaningfully higher than baseline
    // (>$0.50 OR >2% — whichever is larger)
    const minDelta = Math.max(0.50, baseline * 0.02);
    if (latest > baseline + minDelta) {
      alerts.push({
        id: s.id,
        name: s.name,
        category: s.category,
        previous_amount: baseline,
        current_amount: latest,
        last_charge_date: txs[0].date,
        increase: latest - baseline,
        pct_increase: baseline > 0 ? ((latest - baseline) / baseline) * 100 : 0
      });
    }
  }

  // Sort by largest dollar increase first
  alerts.sort((a, b) => b.increase - a.increase);
  res.json(alerts);
});

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

// Look for a recent matching transaction so "Mark Paid" doesn't double-record
// a bill the user already entered manually or imported via CSV.
// Match window: ±5 days, amount tolerance = max($0.50, 2%).
function findRecentMatchingExpense(payee, amount) {
  if (!payee || !amount) return null;
  const tolerance = Math.max(0.50, Math.abs(amount) * 0.02);
  return db.prepare(`
    SELECT id, date, payee, amount FROM transactions
    WHERE lower(payee) = lower(?)
      AND amount < 0
      AND ABS(amount - ?) <= ?
      AND date >= date('now', '-5 days')
      AND date <= date('now', '+5 days')
    ORDER BY date DESC, id DESC
    LIMIT 1
  `).get(payee, -Math.abs(amount), tolerance) || null;
}

app.post('/api/subscriptions/:id/pay', (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const today = new Date().toISOString().split('T')[0];
  const d = new Date(sub.next_due_date + 'T00:00:00');
  if (sub.billing_cycle === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (sub.billing_cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else if (sub.billing_cycle === 'weekly') d.setDate(d.getDate() + 7);
  const nextDate = d.toISOString().slice(0, 10);
  db.prepare('UPDATE subscriptions SET next_due_date = ? WHERE id = ?').run(nextDate, req.params.id);

  // Skip inserting a transaction if one already exists for this charge.
  const matchPayee = (sub.payee && sub.payee.trim()) || sub.name;
  const existing = findRecentMatchingExpense(matchPayee, sub.amount);
  if (existing) {
    return res.json({
      next_due_date: nextDate,
      transaction_id: existing.id,
      skipped: true,
      matched: { id: existing.id, date: existing.date }
    });
  }

  const txResult = db.prepare(
    'INSERT INTO transactions (date, payee, category, amount, notes, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(today, sub.name, sub.category || 'Subscriptions', -Math.abs(sub.amount), `Subscription: ${sub.name}`, 'subscription');
  res.json({ next_due_date: nextDate, transaction_id: txResult.lastInsertRowid, skipped: false });
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

  let transaction_id = null;
  let skipped = false;
  if (reminder.amount) {
    const existing = findRecentMatchingExpense(reminder.title, reminder.amount);
    if (existing) {
      transaction_id = existing.id;
      skipped = true;
    } else {
      const txResult = db.prepare(
        'INSERT INTO transactions (date, payee, category, amount, notes, source) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(today, reminder.title, reminder.category || 'Bills', -Math.abs(reminder.amount), `Bill: ${reminder.title}`, 'bill');
      transaction_id = txResult.lastInsertRowid;
    }
  }

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
    next,
    transaction_id,
    skipped
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

app.get('/api/charts/category-monthly', (req, res) => {
  const months = parseInt(req.query.months) || 6;
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           COALESCE(category, 'Uncategorized') as category,
           SUM(ABS(amount)) as total
    FROM transactions
    WHERE amount < 0 AND date >= date('now', ? || ' months')
    GROUP BY month, category
    ORDER BY month ASC
  `).all(`-${months}`);
  res.json(rows);
});

app.get('/api/charts/available-months', (req, res) => {
  const rows = db.prepare(
    'SELECT DISTINCT strftime(\'%Y-%m\', date) as month FROM transactions ORDER BY month DESC'
  ).all();
  res.json(rows.map(r => r.month));
});

app.get('/api/charts/category-trend', (req, res) => {
  const category = String(req.query.category || '').trim();
  if (!category) return res.status(400).json({ error: 'category required' });
  const months = Math.max(2, Math.min(24, parseInt(req.query.months) || 6));

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', date) as month,
      CAST(strftime('%d', date) AS INTEGER) as day,
      SUM(ABS(amount)) as total
    FROM transactions
    WHERE amount < 0
      AND lower(category) = lower(?)
      AND date >= date('now', 'start of month', ?)
    GROUP BY month, day
    ORDER BY month ASC, day ASC
  `).all(category, `-${months - 1} months`);

  res.json(rows);
});

app.get('/api/charts/payee-trend', (req, res) => {
  const payee = String(req.query.payee || '').trim();
  if (!payee) return res.status(400).json({ error: 'payee required' });
  const months = Math.max(2, Math.min(24, parseInt(req.query.months) || 6));

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', date) as month,
      CAST(strftime('%d', date) AS INTEGER) as day,
      SUM(ABS(amount)) as total
    FROM transactions
    WHERE amount < 0
      AND lower(payee) = lower(?)
      AND date >= date('now', 'start of month', ?)
    GROUP BY month, day
    ORDER BY month ASC, day ASC
  `).all(payee, `-${months - 1} months`);

  res.json(rows);
});

app.get('/api/charts/spending-heatmap', (req, res) => {
  const year = /^\d{4}$/.test(req.query.year) ? req.query.year : String(new Date().getFullYear());
  const rows = db.prepare(`
    SELECT date, SUM(ABS(amount)) as total
    FROM transactions
    WHERE amount < 0 AND strftime('%Y', date) = ?
    GROUP BY date
    ORDER BY date
  `).all(year);
  res.json(rows);
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

// ─── TEMPORAL WORKER (optional — skipped if server unreachable) ───────────────
(async () => {
  if (process.env.TEMPORAL_DISABLED === '1') {
    console.log('Temporal worker disabled (TEMPORAL_DISABLED=1).');
    return;
  }
  try {
    const { startWorker } = require('./temporal/worker');
    await startWorker({ db, sendPushToAll });
    console.log('Temporal worker started and schedules registered.');
  } catch (err) {
    console.warn('Temporal worker not started — notifications will not fire.');
    console.warn('Reason:', err?.message || err);
    console.warn('To enable: start the temporal service (docker compose up temporal).');
  }
})();
