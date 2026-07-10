require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const Database = require('better-sqlite3');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const { createWorker } = require('tesseract.js');

const app = express();
// The app is reachable on two origins: the LAN host (plain HTTP) and a Tailscale
// HTTPS hostname that proxies in over loopback. Trusting the loopback proxy makes
// req.protocol reflect X-Forwarded-Proto (https from Tailscale) so the OIDC
// redirect_uri we build matches the origin the request actually came in on.
app.set('trust proxy', 'loopback');
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'finance.db');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

const crypto = require('crypto');

// ─── DB INIT ──────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// A SEPARATE, strictly READ-ONLY handle to the same DB file. The natural-language
// query feature (/api/query) runs LLM-generated SQL only through this connection,
// so even if the statement validator were somehow bypassed, SQLite itself refuses
// any write (INSERT/UPDATE/DELETE/DDL all error at the engine level). Opened lazily
// so a fresh DB (created just above) already exists on disk before we attach.
let _readonlyDb = null;
function getReadonlyDb() {
  if (_readonlyDb) return _readonlyDb;
  _readonlyDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _readonlyDb;
}

// Migrate: add receipt_path column if it doesn't exist yet
try { db.prepare('ALTER TABLE transactions ADD COLUMN receipt_path TEXT').run(); } catch (_) {}
// Migrate: flag for AI-extracted transactions awaiting human confirmation
try { db.prepare('ALTER TABLE transactions ADD COLUMN needs_review INTEGER DEFAULT 0').run(); } catch (_) {}
// Migrate: add role column to users (existing single user becomes admin)
try { db.prepare("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'").run(); } catch (_) {}
// Migrate: add display_name column to users
try { db.prepare('ALTER TABLE users ADD COLUMN display_name TEXT').run(); } catch (_) {}
// Migrate: Authentik OIDC identity columns (email + subject claim)
try { db.prepare('ALTER TABLE users ADD COLUMN email TEXT').run(); } catch (_) {}
try { db.prepare('ALTER TABLE users ADD COLUMN oidc_sub TEXT').run(); } catch (_) {}
// Migrate: drop the vestigial legacy `password_hash` column. Auth is Authentik
// OIDC only — the column was never read, just written as ''. Idempotent: the
// DROP throws "no such column" once it's gone (and on fresh DBs), which we ignore.
try { db.prepare('ALTER TABLE users DROP COLUMN password_hash').run(); } catch (_) {}

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
    // SECURITY: req.params.id is attacker-controlled (Express decodes %2F), and
    // multer joins this name onto the receipts dir BEFORE the route handler runs
    // its tx-existence check. Without this guard a value like "..%2F..%2Fevil"
    // escapes the uploads directory (path traversal write). Transaction ids are
    // always integers, so reject anything else outright.
    if (!/^\d+$/.test(String(req.params.id))) {
      return cb(new Error('Invalid transaction id'));
    }
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

// Persist sessions in the SQLite DB (the finance.db volume survives restarts/
// redeploys). The default in-memory MemoryStore drops every session on restart
// — so each deploy logged everyone out — and leaks memory over time. The store
// creates and manages its own `sessions` table on the existing db handle.
const SqliteStore = require('better-sqlite3-session-store')(session);
app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }   // sweep expired rows every 15 min
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',                  // sent on the top-level redirect back to /auth/callback
    // 'auto' (with trust proxy set above) marks the cookie Secure only when the
    // request actually arrived over HTTPS — so the Tailscale origin gets a Secure
    // cookie while the plain-HTTP LAN origin still works. Hardcoding secure:true
    // would break LAN login; omitting it left the HTTPS cookie sendable over HTTP.
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ─── WEEKLY DIGEST (token-gated, read-only) ───────────────────────────────────
// Read-only weekly finance AGGREGATES for the homelab's Sunday digest workflow,
// which fetches this over the LAN, narrates it with the local LLM, and posts a
// Slack card. Returns ONLY aggregates (totals, deltas, top categories) — never
// raw transactions. Gated by a bearer token (DIGEST_TOKEN, host-managed in
// finance.env); unset = endpoint disabled (503). Registered BEFORE requireAuth
// so the worker reaches it without an OIDC session. Uses the strictly read-only
// DB handle for defence in depth.
function digestTokenState(req) {
  const expected = process.env.DIGEST_TOKEN;
  if (!expected) return 'disabled';
  const hdr = req.get('authorization') || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  const provided = (m ? m[1] : req.get('x-digest-token') || '').trim();
  if (!provided) return 'missing';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; unequal length is already a mismatch.
  if (a.length !== b.length) return 'bad';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
}

app.get('/api/digest', (req, res) => {
  const state = digestTokenState(req);
  if (state === 'disabled') return res.status(503).json({ error: 'digest endpoint disabled (DIGEST_TOKEN unset)' });
  if (state !== 'ok') return res.status(401).json({ error: 'unauthorized' });

  try {
    const rdb = getReadonlyDb();
    // Two 7-day windows for the week-over-week delta. Dates are 'YYYY-MM-DD', so
    // date(...) normalises any time component before the string comparison.
    const cur  = "date(date) > date('now','-7 days')  AND date(date) <= date('now')";
    const prev = "date(date) > date('now','-14 days') AND date(date) <= date('now','-7 days')";

    const totals = rdb.prepare(`
      SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) END), 0) AS spent,
             COALESCE(SUM(CASE WHEN amount > 0 THEN amount     END), 0) AS income,
             COUNT(*) AS txCount
      FROM transactions WHERE ${cur}
    `).get();

    const spentPrev = rdb.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM transactions WHERE amount < 0 AND ${prev}`
    ).get().total;

    const topCategories = rdb.prepare(`
      SELECT COALESCE(category, 'Uncategorized') AS cat, SUM(ABS(amount)) AS total
      FROM transactions WHERE amount < 0 AND ${cur}
      GROUP BY cat ORDER BY total DESC LIMIT 5
    `).all().map(c => ({ cat: c.cat, total: c.total, pct: totals.spent > 0 ? (c.total / totals.spent) * 100 : 0 }));

    const biggestExpense = rdb.prepare(`
      SELECT payee, ABS(amount) AS amount, date, category
      FROM transactions WHERE amount < 0 AND ${cur}
      ORDER BY ABS(amount) DESC LIMIT 1
    `).get() || null;

    const range = rdb.prepare("SELECT date('now','-6 days') AS start, date('now') AS end").get();
    const spent = totals.spent, income = totals.income, net = income - spent;

    res.json({
      generatedAt: new Date().toISOString(),
      rangeStart: range.start,
      rangeEnd: range.end,
      spent, income, net,
      txCount: totals.txCount,
      savingsRate: income > 0 ? (net / income) * 100 : null,
      spentPrev,
      spentDeltaPct: spentPrev > 0 ? ((spent - spentPrev) / spentPrev) * 100 : null,
      topCategories,
      biggestExpense
    });
  } catch (err) {
    console.error('digest endpoint failed:', err);
    res.status(500).json({ error: 'digest query failed' });
  }
});

// ─── AGENT SUMMARY (token-gated, read-only) ───────────────────────────────────
// Topic-scoped finance AGGREGATES for the homelab's central agent, which fetches
// these over the LAN on demand. Returns ONLY aggregates and top-N summaries —
// never raw transaction rows (the sole description fragment allowed is the
// truncated merchant name on the `biggest` topic). Gated by its OWN bearer token
// (AGENT_TOKEN, host-managed in finance.env — deliberately separate from
// DIGEST_TOKEN); unset = endpoint disabled (503). Registered BEFORE requireAuth
// so the agent reaches it without an OIDC session. Uses the strictly read-only
// DB handle for defence in depth.
function agentTokenState(req) {
  const expected = process.env.AGENT_TOKEN;
  if (!expected) return 'disabled';
  const hdr = req.get('authorization') || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  const provided = (m ? m[1] : req.get('x-agent-token') || '').trim();
  if (!provided) return 'missing';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; unequal length is already a mismatch.
  if (a.length !== b.length) return 'bad';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
}

// `window` query param → whole days, default 30, clamped to 1..365.
function clampAgentWindowDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, n));
}

// Normalize a subscription's amount to its monthly cost. Mirrors the UI's math
// in public/js/subscriptions.js exactly (monthly ×1, yearly ÷12, weekly ×4.33;
// unknown cycles contribute 0).
function subscriptionMonthlyAmount(amount, billingCycle) {
  const amt = Math.abs(amount);
  if (billingCycle === 'monthly') return amt;
  if (billingCycle === 'yearly')  return amt / 12;
  if (billingCycle === 'weekly')  return amt * 4.33;
  return 0;
}

const AGENT_TOPICS = new Set(['overview', 'categories', 'monthly', 'subscriptions', 'biggest']);

app.get('/api/agent/summary', (req, res) => {
  const state = agentTokenState(req);
  if (state === 'disabled') return res.status(503).json({ error: 'agent endpoint disabled (AGENT_TOKEN unset)' });
  if (state !== 'ok') return res.status(401).json({ error: 'unauthorized' });

  const topic = String(req.query.topic || '');
  if (!AGENT_TOPICS.has(topic)) {
    return res.status(400).json({ error: `unknown topic (expected one of: ${[...AGENT_TOPICS].join(', ')})` });
  }
  const days = clampAgentWindowDays(req.query.window);

  try {
    const rdb = getReadonlyDb();
    // Same date convention as /api/digest: dates are 'YYYY-MM-DD' strings, so
    // date(...) normalises any time component before the string comparison.
    // `days` is a server-clamped integer (never user text), so inlining is safe.
    const cur  = `date(date) > date('now','-${days} days') AND date(date) <= date('now')`;
    const prev = `date(date) > date('now','-${2 * days} days') AND date(date) <= date('now','-${days} days')`;
    const body = { topic, window: days, generatedAt: new Date().toISOString() };

    if (topic === 'overview') {
      const totals = rdb.prepare(`
        SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) END), 0) AS spent,
               COALESCE(SUM(CASE WHEN amount > 0 THEN amount     END), 0) AS income,
               COUNT(*) AS txCount
        FROM transactions WHERE ${cur}
      `).get();
      const spentPrev = rdb.prepare(
        `SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM transactions WHERE amount < 0 AND ${prev}`
      ).get().total;
      const spent = totals.spent, income = totals.income, net = income - spent;
      Object.assign(body, {
        spent, income, net,
        txCount: totals.txCount,
        savingsRate: income > 0 ? (net / income) * 100 : null,
        spentPrev,
        spentDeltaPct: spentPrev > 0 ? ((spent - spentPrev) / spentPrev) * 100 : null
      });
    } else if (topic === 'categories') {
      const totalSpent = rdb.prepare(
        `SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM transactions WHERE amount < 0 AND ${cur}`
      ).get().total;
      body.categories = rdb.prepare(`
        SELECT COALESCE(category, 'Uncategorized') AS category,
               SUM(ABS(amount)) AS spent,
               COUNT(*) AS txCount
        FROM transactions WHERE amount < 0 AND ${cur}
        GROUP BY category ORDER BY spent DESC LIMIT 12
      `).all().map(c => ({
        category: c.category,
        spent: c.spent,
        pct: totalSpent > 0 ? (c.spent / totalSpent) * 100 : 0,
        txCount: c.txCount
      }));
    } else if (topic === 'monthly') {
      // Window (days) → whole calendar months, min 3 max 12, current month included.
      const months = Math.min(12, Math.max(3, Math.round(days / 30)));
      body.months = rdb.prepare(`
        SELECT strftime('%Y-%m', date) AS month,
               COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) END), 0) AS spent,
               COALESCE(SUM(CASE WHEN amount > 0 THEN amount     END), 0) AS income
        FROM transactions
        WHERE date(date) >= date('now', 'start of month', '-${months - 1} months')
          AND date(date) <= date('now')
        GROUP BY month ORDER BY month
      `).all().map(m => ({ month: m.month, spent: m.spent, income: m.income, net: m.income - m.spent }));
    } else if (topic === 'subscriptions') {
      const subs = rdb.prepare(`
        SELECT name, amount, billing_cycle, next_due_date
        FROM subscriptions WHERE active = 1
        ORDER BY name COLLATE NOCASE
      `).all();
      body.subscriptions = subs.map(s => ({
        name: s.name,
        amount: Math.abs(s.amount),
        frequency: s.billing_cycle,
        nextDue: s.next_due_date || null
      }));
      body.monthlyTotal = subs.reduce((a, s) => a + subscriptionMonthlyAmount(s.amount, s.billing_cycle), 0);
    } else if (topic === 'biggest') {
      body.expenses = rdb.prepare(`
        SELECT ABS(amount) AS amount, COALESCE(category, 'Uncategorized') AS category, date, payee
        FROM transactions WHERE amount < 0 AND ${cur}
        ORDER BY ABS(amount) DESC LIMIT 8
      `).all().map(e => ({
        amount: e.amount,
        category: e.category,
        date: e.date,
        // The one allowed description fragment: the merchant name, truncated.
        merchant: String(e.payee || '').slice(0, 40)
      }));
    }

    res.json(body);
  } catch (err) {
    console.error('agent summary endpoint failed:', err);
    res.status(500).json({ error: 'agent summary query failed' });
  }
});

// ─── AUTH (Authentik OIDC) ─────────────────────────────────────────────────────

// Lazily discover the Authentik issuer and build the OIDC client on first use,
// so a missing/unreachable IdP doesn't block server boot. Use the SAME external
// (host-IP) issuer URL the browser hits, so the `iss` claim validates.
let _oidcClient = null;
async function getOidcClient() {
  if (_oidcClient) return _oidcClient;
  const issuer = await Issuer.discover(process.env.OIDC_ISSUER);
  _oidcClient = new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID,
    client_secret: process.env.OIDC_CLIENT_SECRET,
    // redirect_uri is supplied per-request (see redirectUriFor); this default is
    // only a fallback for tooling that reads client metadata.
    redirect_uris: [process.env.OIDC_REDIRECT_URI].filter(Boolean),
    response_types: ['code']
  });
  return _oidcClient;
}

// Build the external base URL the *current* request arrived on, honouring the
// Tailscale proxy's forwarded headers. This is what lets one app instance serve
// both the LAN origin (http://<ip>:<port>) and the Tailscale origin
// (https://<name>.ts.net) without the OIDC flow snapping back to a single host.
function externalBase(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  let host    = (req.get('x-forwarded-host')  || req.get('host') || '').split(',')[0].trim();
  // Tailscale serve on a non-default port passes the hostname in X-Forwarded-Host
  // but the port separately in X-Forwarded-Port. Without restoring it, the origin
  // (and thus the OIDC redirect_uri) loses the :port and stops matching what the
  // browser actually used — e.g. the front door on :3090. Only append a non-default
  // port, and only when the host doesn't already carry one.
  if (host && !host.includes(':')) {
    const port = (req.get('x-forwarded-port') || '').split(',')[0].trim();
    const isDefault = (proto === 'https' && port === '443') || (proto === 'http' && port === '80');
    if (port && !isDefault) host = `${host}:${port}`;
  }
  return `${proto}://${host}`;
}
// The OIDC redirect_uri for this request's origin. Falls back to the static env
// value if, somehow, no Host header is present. Every origin's
// `${base}/auth/callback` must be registered on the Authentik provider.
function redirectUriFor(req) {
  try { return `${externalBase(req)}/auth/callback`; }
  catch { return process.env.OIDC_REDIRECT_URI; }
}

// When a request arrives through the Tailscale proxy (x-forwarded-proto=https),
// the browser is off-LAN and cannot reach the LAN Authentik host that openid-client
// discovered. Swap ONLY the origin of a BROWSER-FACING Authentik URL — the
// authorization endpoint at login AND the end-session endpoint at logout — to the
// public (Tailscale) origin in OIDC_PUBLIC_BASE so the user-agent can reach it.
// Back-channel calls (discovery, token, jwks) keep using the LAN OIDC_ISSUER, which
// the container reaches directly — so the `iss` claim still validates. LAN/direct
// (http) requests keep the discovered URL untouched.
function publicAuthOrigin(req, url) {
  const pub = process.env.OIDC_PUBLIC_BASE;
  if (!pub) return url;
  const fwdProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  if (fwdProto !== 'https') return url;
  const out = new URL(url);
  const base = new URL(pub);
  out.protocol = base.protocol;
  out.host = base.host;   // swap origin; keep the path (/authorize, /end-session) + query
  return out.toString();
}

// users.username is UNIQUE, but the real OIDC identity is oidc_sub — the handle is
// just a label. Return `desired` if no OTHER row holds it, else suffix it so a
// clash with a different account never aborts the whole login. excludeId is the
// row we're about to write (it may legitimately already own the name).
function freeUsername(desired, excludeId = null) {
  const clash = db.prepare(
    'SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND (? IS NULL OR id != ?)'
  );
  const base = desired || 'user';
  let candidate = base, n = 1;
  while (clash.get(candidate, excludeId, excludeId)) candidate = `${base}-${++n}`;
  return candidate;
}

// ─── ROLES (Authentik group → app role) ───────────────────────────────────────
// Three roles, highest privilege wins: admin > member > viewer.
//   • admin  — everything (config + destructive ops).
//   • member — everyday writes (log/edit transactions, mark bills & subs paid,
//              contribute to goals, import CSV, OCR receipts). NOT config/destroy.
//   • viewer — read-only (plus the read-only "Ask" NL query and own profile).
// The role is driven by Authentik group membership delivered in the OIDC `groups`
// claim, so changing a user's group in Authentik propagates on their next login.
// The OIDC scope must therefore request `groups` (see OIDC_SCOPE) AND the Authentik
// provider needs a scope mapping that emits the user's groups (see README).
const { APP_ROLES, canAccess, roleFromGroups } = require('./db/rbac');
const OIDC_GROUP_MAP = {
  admin:  (process.env.OIDC_ADMIN_GROUP  || 'finance-admins'),
  member: (process.env.OIDC_MEMBER_GROUP || 'finance-members'),
  viewer: (process.env.OIDC_VIEWER_GROUP || 'finance-viewers'),
  // Role for an authenticated user who matches none of the groups above. Defaults
  // to least privilege (viewer) — a user must be explicitly granted member/admin.
  fallback: APP_ROLES.has(String(process.env.OIDC_DEFAULT_ROLE || '').toLowerCase())
    ? String(process.env.OIDC_DEFAULT_ROLE).toLowerCase()
    : 'viewer',
};

// Map an Authentik identity to a local users row. Order: (1) match an existing
// row by oidc_sub, else (2) create a new row. (oidc_sub is the stable Authentik
// identity; every row is provisioned through this path, so there are no unlinked
// legacy rows to adopt.)
//
// Role: when the `groups` claim is PRESENT, the role is derived from it on every
// login (Authentik is the source of truth). When it is ABSENT — Authentik hasn't
// been wired up with a groups mapping yet — we DON'T touch roles: existing users
// keep their stored role and a brand-new install bootstraps the first user to
// admin, everyone after to member. This keeps deploying the feature from ever
// locking anyone out before the Authentik side is configured.
function upsertOidcUser(claims) {
  const sub      = claims.sub;
  const email    = claims.email || null;
  const username = String(claims.preferred_username || claims.email || sub).trim();
  const display  = claims.name || null;
  const hasGroups    = Array.isArray(claims.groups);
  const derivedRole  = hasGroups ? roleFromGroups(claims.groups, OIDC_GROUP_MAP) : null;

  const bySub = db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub);
  if (bySub) {
    const name = freeUsername(username, bySub.id);
    const role = derivedRole || bySub.role;   // reflect Authentik when groups present
    db.prepare('UPDATE users SET username = ?, email = COALESCE(?, email), role = ? WHERE id = ?')
      .run(name, email, role, bySub.id);
    return { id: bySub.id, username: name, role };
  }

  let role;
  if (derivedRole) {
    role = derivedRole;
  } else {
    const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
    role = userCount === 0 ? 'admin' : 'member';   // legacy bootstrap (no groups claim)
  }
  const name = freeUsername(username);
  const result = db.prepare(
    "INSERT INTO users (username, role, email, oidc_sub, display_name) VALUES (?, ?, ?, ?, ?)"
  ).run(name, role, email, sub, display);
  return { id: result.lastInsertRowid, username: name, role };
}

function requireAuth(req, res, next) {
  const PUBLIC = new Set(['/auth/login', '/auth/callback']);
  if (PUBLIC.has(req.path)) return next();
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/auth/login');
}

// Kick off the OIDC login: PKCE + state + nonce stored in the session, then
// redirect to Authentik's authorization endpoint.
app.get('/auth/login', async (req, res, next) => {
  try {
    if (req.session?.user) return res.redirect('/');
    const client = await getOidcClient();
    const code_verifier  = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);
    const state = generators.state();
    const nonce = generators.nonce();
    // Pin the callback to THIS request's origin and remember it for the callback
    // step (openid-client requires the same redirect_uri at both ends).
    const redirect_uri = redirectUriFor(req);
    req.session.oidc = { code_verifier, state, nonce, redirect_uri };
    res.redirect(publicAuthOrigin(req, client.authorizationUrl({
      redirect_uri,
      // The `groups` claim (→ app role, see roleFromGroups) is emitted by
      // Authentik's DEFAULT `profile` scope mapping, so requesting `profile` is
      // enough — no dedicated `groups` scope mapping needed. If your IdP only
      // exposes groups under a separate scope, add it via OIDC_SCOPE. A missing
      // groups claim degrades gracefully (see upsertOidcUser).
      scope: process.env.OIDC_SCOPE || 'openid profile email',
      code_challenge,
      code_challenge_method: 'S256',
      state,
      nonce
    })));
  } catch (err) {
    console.error('[oidc] login error:', err.message);
    next(err);
  }
});

// OIDC redirect target: validate code/state/nonce, provision the user, open the
// app session.
app.get('/auth/callback', async (req, res, next) => {
  try {
    const saved = req.session.oidc;
    if (!saved) return res.redirect('/auth/login');
    const client = await getOidcClient();
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(saved.redirect_uri || process.env.OIDC_REDIRECT_URI, params, {
      code_verifier: saved.code_verifier,
      state: saved.state,
      nonce: saved.nonce
    });
    delete req.session.oidc;
    const user = upsertOidcUser(tokenSet.claims());
    req.session.id_token = tokenSet.id_token;   // for RP-initiated logout
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect('/');
  } catch (err) {
    console.error('[oidc] callback error:', err.message);
    next(err);
  }
});

// Clear the local session, then (if configured) bounce through Authentik's
// end-session endpoint so the IdP session is cleared too.
app.get('/auth/logout', (req, res) => {
  const idToken = req.session.id_token;
  // Capture the origin before the session is destroyed so we return to the same
  // host (LAN vs Tailscale) the user logged out from.
  const postLogout = `${externalBase(req)}/auth/login`;
  // OIDC_POST_LOGOUT_REDIRECT_URI is now just an on/off flag for RP-initiated
  // logout (clearing the Authentik SSO session too); the target is origin-derived.
  const rpLogout = !!process.env.OIDC_POST_LOGOUT_REDIRECT_URI;
  req.session.destroy(async () => {
    try {
      if (rpLogout && idToken) {
        const client = await getOidcClient();
        if (client.issuer.metadata.end_session_endpoint) {
          // Swap the end-session origin to the public (Tailscale) Authentik host
          // when off-LAN — otherwise the browser is redirected to the LAN-only
          // end_session_endpoint it can't reach and logout fails over Tailscale.
          return res.redirect(publicAuthOrigin(req, client.endSessionUrl({
            id_token_hint: idToken,
            post_logout_redirect_uri: postLogout
          })));
        }
      }
    } catch (err) {
      console.error('[oidc] logout error:', err.message);
    }
    res.redirect('/auth/login');
  });
});

// ─── EVERYTHING BELOW REQUIRES A VALID AUTHENTIK SESSION ───────────────────────
// The only routes reachable unauthenticated are /health and the three /auth/*
// OIDC routes above. This gate covers all data/API endpoints, static assets, and
// receipts — there is no way into the app without completing the Authentik flow.
app.use(requireAuth);

// ─── AUTHORIZATION (role gate) ─────────────────────────────────────────────────
// requireAuth proves WHO you are; this proves WHAT you may do. The whole policy
// lives in db/rbac.js (default-deny on writes); here we just feed it the request.
function authorize(req, res, next) {
  const role = req.session?.user?.role || 'viewer';
  if (canAccess(role, req.method, req.path)) return next();
  return res.status(403).json({ error: `Forbidden: your role (${role}) cannot perform this action` });
}
app.use(authorize);

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

// Static files (auth-gated — requireAuth is applied above)
app.use(express.static(path.join(__dirname, 'public')));

// Serve receipt images (auth-gated)
app.use('/receipts', express.static(path.join(__dirname, 'uploads', 'receipts')));

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────

// Build a dynamic push payload for a freshly-inserted transaction. Picks the
// most signal-rich context line (budget %, payee deviation, day running total,
// or MTD net for income) so the lock-screen tells you something useful without
// needing to open the app. Wrapped in try/catch so any enrichment failure
// degrades to the simple static body rather than blocking the tx response.
function buildTxNotification(row, actorName) {
  const signedAmt = row.amount < 0
    ? `-$${Math.abs(row.amount).toFixed(2)}`
    : `+$${row.amount.toFixed(2)}`;
  const baseLine = `${row.payee} · ${signedAmt}${row.category ? ` · ${row.category}` : ''}`;
  const isIncome = row.amount > 0;
  const titleEmoji = isIncome ? '💰' : '💸';
  const titleVerb  = isIncome ? 'logged income' : 'added a transaction';
  const fallback = {
    title: `${titleEmoji} ${actorName} ${titleVerb}`,
    body: baseLine,
    tag: `tx-added-${row.id}`,
    data: { route: '#/transactions', txId: row.id }
  };

  try {
    const monthKey = row.date.slice(0, 7);
    const monthLabel = new Date(row.date + 'T00:00:00').toLocaleString('en-US', { month: 'short' });
    let contextLine = null;

    if (isIncome) {
      const mtd = db.prepare(
        "SELECT COALESCE(SUM(amount), 0) AS net FROM transactions WHERE strftime('%Y-%m', date) = ?"
      ).get(monthKey);
      const net = mtd.net;
      const sign = net >= 0 ? '+' : '-';
      contextLine = `${monthLabel} net so far: ${sign}$${Math.abs(net).toFixed(2)}`;
    } else if (row.category) {
      const budget = db.prepare(
        'SELECT amount FROM budgets WHERE category = ? COLLATE NOCASE'
      ).get(row.category);
      if (budget) {
        const spent = db.prepare(
          "SELECT COALESCE(SUM(ABS(amount)), 0) AS out FROM transactions WHERE lower(category) = lower(?) AND amount < 0 AND strftime('%Y-%m', date) = ?"
        ).get(row.category, monthKey);
        const pct = (spent.out / budget.amount) * 100;
        contextLine = `${row.category}: ${pct.toFixed(0)}% of ${monthLabel} ($${spent.out.toFixed(0)} of $${budget.amount.toFixed(0)})`;
      }
    }

    if (!contextLine && !isIncome) {
      const payeeStats = db.prepare(
        "SELECT COUNT(*) AS cnt, AVG(ABS(amount)) AS avg FROM transactions WHERE lower(payee) = lower(?) AND amount < 0 AND id != ? AND date >= date('now', '-180 days')"
      ).get(row.payee, row.id);
      if (payeeStats && payeeStats.cnt >= 3 && payeeStats.avg > 0) {
        const thisAmt = Math.abs(row.amount);
        const deltaPct = ((thisAmt - payeeStats.avg) / payeeStats.avg) * 100;
        const sign = deltaPct >= 0 ? '+' : '';
        contextLine = `Avg at ${row.payee}: $${payeeStats.avg.toFixed(0)} (this ${sign}${deltaPct.toFixed(0)}%)`;
      }
    }

    if (!contextLine && !isIncome) {
      const today = db.prepare(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(ABS(amount)), 0) AS out FROM transactions WHERE date = ? AND amount < 0"
      ).get(row.date);
      if (today.cnt > 1) {
        contextLine = `Today: -$${today.out.toFixed(2)} across ${today.cnt} txns`;
      }
    }

    return {
      ...fallback,
      body: contextLine ? `${baseLine}\n${contextLine}` : baseLine
    };
  } catch (err) {
    console.error('[push] buildTxNotification failed, using fallback:', err.message);
    return fallback;
  }
}

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

  // Notify other devices in the household (excluding the originator).
  // Routed through a Temporal workflow so every push attempt is visible in
  // the Temporal UI (workflow type: sendPushWorkflow). Falls back to a
  // direct call if Temporal isn't reachable.
  const myEndpoint = req.get('X-Push-Endpoint') || null;
  const me = req.session?.user;
  const actor = me ? (db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(me.id) || {}) : {};
  const actorName = (actor.display_name || actor.username || 'Someone');
  const pushPayload = buildTxNotification(row, actorName);

  let temporalClient = null;
  try { temporalClient = require('./temporal/worker').getClient(); } catch (_) {}

  if (temporalClient) {
    temporalClient.workflow.start('sendPushWorkflow', {
      args: [{ excludeEndpoint: myEndpoint, payload: pushPayload }],
      taskQueue: 'finance-tq',
      workflowId: `push-tx-${row.id}-${Date.now()}`
    })
      .then(handle => console.log(`[push] tx-added id=${row.id} workflow=${handle.workflowId}`))
      .catch(err => {
        console.error('[push] tx-added workflow start failed:', err.message);
        // Fall back to direct push so user still gets notified
        sendPushExcept(myEndpoint, pushPayload).catch(e2 => console.error('[push] fallback failed:', e2));
      });
  } else {
    console.log(`[push] tx-added id=${row.id} (direct — temporal unavailable)`);
    sendPushExcept(myEndpoint, pushPayload)
      .then(r => console.log(`[push] tx-added id=${row.id} direct sent=${r.sent} failed=${r.failed}`))
      .catch(err => console.error('[push] tx-added direct failed:', err));
  }

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

// Clear the needs_review flag on an AI-extracted transaction (one-tap "confirm").
app.post('/api/transactions/:id/confirm', (req, res) => {
  const tx = db.prepare('SELECT id FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE transactions SET needs_review = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id));
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

// Shared OCR helper — used inline above and injected into the Temporal worker
// so the receipt-ingest activity can fall back to OCR text when the local
// model isn't vision-capable. Returns the raw recognised text.
async function ocrReceiptText(buffer) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return data?.text || '';
}

// ─── RECEIPT AI INGEST (local LLM via Temporal) ───────────────────────────────
// Fire-and-forget: store the image, start a durable workflow that reads it with
// the local model, creates a needs_review transaction, and pushes when done.
const ingestStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'receipts');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `receipt-ai-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  }
});
const ingestUpload = multer({
  storage: ingestStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

app.post('/api/receipts/ingest', ingestUpload.single('receipt'), (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.file) return res.status(400).json({ error: 'Send an image as multipart field "receipt" (jpg/png/webp, max 10 MB)' });

  let temporalClient = null;
  try { temporalClient = require('./temporal/worker').getClient(); } catch (_) {}
  if (!temporalClient) {
    fs.unlink(req.file.path, () => {});   // can't process async — don't orphan the file
    return res.status(503).json({ error: 'Receipt AI is unavailable (Temporal worker not running).' });
  }

  const myEndpoint = req.get('X-Push-Endpoint') || null;
  const actor = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(req.session.user.id) || {};
  const actorName = actor.display_name || actor.username || 'Someone';

  temporalClient.workflow.start('receiptIngestWorkflow', {
    args: [{ receiptFile: req.file.filename, excludeEndpoint: myEndpoint, actorName }],
    taskQueue: 'finance-tq',
    workflowId: `receipt-ingest-${req.file.filename}`
  })
    .then(h => console.log(`[receipt-ai] started workflow=${h.workflowId}`))
    .catch(err => {
      console.error('[receipt-ai] workflow start failed:', err.message);
      fs.unlink(req.file.path, () => {});
    });

  res.status(202).json({ status: 'processing', receipt_path: req.file.filename });
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

// ─── SAVINGS GOALS ────────────────────────────────────────────────────────────
// Forward-looking savings targets. Household-shared (auth-gated above). Each
// goal tracks an amount saved toward a target, optionally by a target date.

app.get('/api/savings-goals', (req, res) => {
  const { active } = req.query;
  let sql = 'SELECT * FROM savings_goals';
  const params = [];
  if (active !== undefined) {
    sql += ' WHERE active = ?';
    params.push(parseInt(active));
  }
  sql += ' ORDER BY active DESC, created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/savings-goals/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/savings-goals', (req, res) => {
  const { name, target_amount, saved_amount, target_date, notes } = req.body;
  if (!name?.trim() || target_amount === undefined || parseFloat(target_amount) <= 0) {
    return res.status(400).json({ error: 'name and a positive target_amount are required' });
  }
  const result = db.prepare(`
    INSERT INTO savings_goals (name, target_amount, saved_amount, target_date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    parseFloat(target_amount),
    saved_amount !== undefined ? Math.max(0, parseFloat(saved_amount) || 0) : 0,
    target_date || null,
    notes || null
  );
  res.json(db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/savings-goals/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const fields = ['name', 'target_amount', 'saved_amount', 'target_date', 'notes', 'active'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (updates.target_amount !== undefined) {
    const t = parseFloat(updates.target_amount);
    if (!(t > 0)) return res.status(400).json({ error: 'target_amount must be positive' });
    updates.target_amount = t;
  }
  if (updates.saved_amount !== undefined) updates.saved_amount = Math.max(0, parseFloat(updates.saved_amount) || 0);
  if (updates.active !== undefined) updates.active = parseInt(updates.active) ? 1 : 0;

  if (Object.keys(updates).length === 0) return res.json(existing);
  const cols = Object.keys(updates);
  const setClauses = cols.map(k => `${k} = ?`).join(', ') + ", updated_at = datetime('now')";
  db.prepare(`UPDATE savings_goals SET ${setClauses} WHERE id = ?`).run(...cols.map(k => updates[k]), req.params.id);
  res.json(db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(req.params.id));
});

app.delete('/api/savings-goals/:id', (req, res) => {
  const result = db.prepare('DELETE FROM savings_goals WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Add a contribution toward a goal — increments saved_amount (never below 0,
// to allow corrections). Returns the updated goal plus a `reached` flag so the
// client can celebrate when a contribution tips the goal over its target.
app.post('/api/savings-goals/:id/contribute', (req, res) => {
  const goal = db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'Not found' });
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount === 0) return res.status(400).json({ error: 'a non-zero amount is required' });

  const wasReached = goal.saved_amount >= goal.target_amount;
  const newSaved = Math.max(0, goal.saved_amount + amount);
  db.prepare(
    "UPDATE savings_goals SET saved_amount = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newSaved, goal.id);

  const updated = db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(goal.id);
  res.json({ goal: updated, reached: !wasReached && updated.saved_amount >= updated.target_amount });
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

// ─── NATURAL-LANGUAGE QUERY (local Ollama → read-only SQL) ─────────────────────
// Ask a plain-English question ("how much on coffee since March?"); the local
// Ollama model translates it to a single SELECT over a read-only view of the DB;
// we validate + execute it on the readonly handle and return rows + a one-line
// summary. The LLM output is treated as UNTRUSTED — see validateReadonlySql.

// Local LLM (Ollama). Same address/style as temporal/activities.js, but its OWN
// vars so the query model can differ from the receipt-vision model. /api/generate
// is the native completion endpoint. NLQUERY_ENABLED gates the whole feature off.
const OLLAMA_BASE_URL  = (process.env.OLLAMA_BASE_URL || 'http://192.168.50.34:11434').replace(/\/+$/, '');
const OLLAMA_MODEL     = process.env.OLLAMA_MODEL || 'gemma3:4b';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '30000', 10);
// Default ON; set NLQUERY_ENABLED=0 (or false) to disable the endpoint entirely.
const NLQUERY_ENABLED  = !['0', 'false', 'no', 'off'].includes(
  String(process.env.NLQUERY_ENABLED ?? '1').toLowerCase()
);
// Read-only SQL safety validator + row cap live in their own module so they can
// be unit-tested in isolation (see db/sql-safety.js, test/sql-safety.test.js).
const { validateReadonlySql, NLQUERY_ROW_CAP } = require('./db/sql-safety');

// Schema description handed to the model. Kept curated (not the raw schema.sql) so
// the model only ever sees the user-data tables — never users/sessions/secrets.
const NLQUERY_SCHEMA_DOC = `
You are a SQLite expert for a personal finance app. Tables (only these — never reference any others):

transactions(id, date TEXT 'YYYY-MM-DD', payee TEXT, category TEXT, amount REAL, notes TEXT, source TEXT)
  -- amount is NEGATIVE for expenses/spending, POSITIVE for income.
budgets(id, category TEXT, amount REAL)            -- monthly budget per category
subscriptions(id, name TEXT, amount REAL, billing_cycle TEXT, next_due_date TEXT, category TEXT, payee TEXT, active INTEGER)
reminders(id, title TEXT, due_date TEXT, amount REAL, category TEXT, paid INTEGER)
categories(id, name TEXT)

Conventions:
- Spending/expense totals use amount < 0; show them as ABS(amount) or SUM(ABS(amount)).
- Income uses amount > 0.
- Dates are ISO 'YYYY-MM-DD'. Use SQLite date funcs, e.g. strftime('%Y-%m', date), date('now', '-3 months').
- Match text case-insensitively, e.g. lower(category) LIKE '%coffee%'.
`.trim();

// Build the completion prompt: schema + question + strict output contract.
function buildNlQueryPrompt(question) {
  return `${NLQUERY_SCHEMA_DOC}

Translate the user's question into ONE read-only SQLite SELECT statement.
Rules:
- Output ONLY the SQL — no prose, no code fences, no comments, no semicolon.
- Use a SELECT (or a WITH … SELECT). Never write, modify, or define anything.
- Prefer labelling output columns with clear aliases (e.g. SUM(ABS(amount)) AS total).
- Always include a LIMIT (max ${NLQUERY_ROW_CAP}).

Question: ${question}

SQL:`;
}

// Ask the model to summarise a result set in one short sentence. Best-effort:
// returns null on any failure so the endpoint still works without a summary.
async function summariseNlResult(question, columns, rows) {
  try {
    const sample = rows.slice(0, 20);
    const prompt = `A user asked: "${question}"
The SQL query returned these columns: ${columns.join(', ')}
and these rows (JSON): ${JSON.stringify(sample)}

Answer the user's question in ONE short, friendly sentence. Use $ for money amounts. Do not mention SQL.`;
    const data = await callOllamaGenerate({ model: OLLAMA_MODEL, prompt });
    const text = String(data || '').trim();
    return text ? text.slice(0, 400) : null;
  } catch (_) {
    return null;
  }
}

// Call Ollama's native /api/generate and return the raw text response. Times out
// (AbortController) so an unreachable/slow homelab box fails fast and cleanly.
async function callOllamaGenerate({ model, prompt }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0 } }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data && data.response) || '';
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/query/status', (req, res) => {
  res.json({ enabled: NLQUERY_ENABLED, model: OLLAMA_MODEL });
});

app.post('/api/query', async (req, res) => {
  if (!NLQUERY_ENABLED) {
    return res.status(503).json({ error: 'Natural-language query is disabled (NLQUERY_ENABLED=0).' });
  }
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'A question is required' });
  if (question.length > 500) return res.status(400).json({ error: 'Question too long (max 500 chars)' });

  // 1) Ask the model to translate the question to SQL.
  let rawSql;
  try {
    rawSql = await callOllamaGenerate({ model: OLLAMA_MODEL, prompt: buildNlQueryPrompt(question) });
  } catch (err) {
    console.error('[nlquery] Ollama call failed:', err.message);
    const unreachable = /abort|fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(err.message);
    return res.status(503).json({
      error: unreachable
        ? `Could not reach the local AI model at ${OLLAMA_BASE_URL}. Is Ollama running?`
        : `AI model error: ${err.message}`
    });
  }

  // 2) Validate the generated SQL — fail closed on anything non-conforming.
  let sql;
  try {
    sql = validateReadonlySql(rawSql);
  } catch (err) {
    console.warn('[nlquery] rejected SQL:', err.message, '|', String(rawSql).slice(0, 200));
    return res.status(422).json({
      error: `The AI produced a query I won't run: ${err.message}`,
      sql: String(rawSql).slice(0, 500)
    });
  }

  // 3) Execute on the strictly READ-ONLY connection.
  let rows, columns;
  try {
    const stmt = getReadonlyDb().prepare(sql);
    rows = stmt.all();
    columns = rows.length ? Object.keys(rows[0]) : (stmt.columns().map(c => c.name));
    if (rows.length > NLQUERY_ROW_CAP) rows = rows.slice(0, NLQUERY_ROW_CAP);
  } catch (err) {
    console.warn('[nlquery] SQL execution failed:', err.message);
    return res.status(422).json({
      error: `The generated query failed to run: ${err.message}`,
      sql
    });
  }

  // 4) Best-effort one-line natural-language answer.
  const summary = await summariseNlResult(question, columns, rows);

  res.json({ sql, columns, rows, summary });
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
    let s = String(v);
    // SECURITY: defang spreadsheet formula injection. A field beginning with
    // = + - @ (or tab/CR) is interpreted as a formula by Excel/Sheets when the
    // exported CSV is opened, so prefix those with a single quote to neutralise.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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
    await startWorker({ db, sendPushToAll, sendPushExcept, applyRules, ocrReceiptText });
    console.log('Temporal worker started and schedules registered.');
  } catch (err) {
    console.warn('Temporal worker not started — notifications will not fire.');
    console.warn('Reason:', err?.message || err);
    console.warn('To enable: start the temporal service (docker compose up temporal).');
  }
})();
