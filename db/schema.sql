PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    payee       TEXT    NOT NULL,
    category    TEXT,
    amount      REAL    NOT NULL,
    notes       TEXT,
    source      TEXT    DEFAULT 'manual',
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    amount          REAL    NOT NULL,
    billing_cycle   TEXT    NOT NULL,
    next_due_date   TEXT    NOT NULL,
    category        TEXT,
    payee           TEXT,
    notes           TEXT,
    active          INTEGER DEFAULT 1,
    created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    due_date    TEXT    NOT NULL,
    amount      REAL,
    category    TEXT,
    recurring   INTEGER DEFAULT 0,
    recur_days  INTEGER,
    paid        INTEGER DEFAULT 0,
    paid_date   TEXT,
    notes       TEXT,
    created_at  TEXT    DEFAULT (datetime('now'))
);

-- Users are provisioned via Authentik OIDC (see server.js). `oidc_sub` is the
-- Authentik subject claim; `email`/`username` come from the OIDC claims.
-- `password_hash` is retained (legacy, may be NULL) so old rows still satisfy
-- their original NOT NULL constraint, but is no longer used for login.
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT,
    email         TEXT,
    oidc_sub      TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT UNIQUE NOT NULL COLLATE NOCASE,
    amount     REAL NOT NULL CHECK(amount > 0),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    endpoint    TEXT    UNIQUE NOT NULL,
    p256dh      TEXT    NOT NULL,
    auth        TEXT    NOT NULL,
    user_agent  TEXT,
    created_at  TEXT    DEFAULT (datetime('now')),
    last_seen   TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    condition_field TEXT    NOT NULL,   -- 'payee' | 'notes' | 'amount'
    condition_op    TEXT    NOT NULL,   -- 'contains' | 'equals' | 'starts_with' | 'gt' | 'lt' | 'gte' | 'lte'
    condition_value TEXT    NOT NULL,
    action_type     TEXT    NOT NULL,   -- 'set_category'
    action_value    TEXT    NOT NULL,
    priority        INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS savings_goals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    target_amount REAL    NOT NULL CHECK(target_amount > 0),
    saved_amount  REAL    NOT NULL DEFAULT 0,
    target_date   TEXT,
    notes         TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    DEFAULT (datetime('now')),
    updated_at    TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_payee    ON transactions(payee);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_reminders_due_date    ON reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due     ON subscriptions(next_due_date);
CREATE INDEX IF NOT EXISTS idx_savings_goals_active   ON savings_goals(active);
