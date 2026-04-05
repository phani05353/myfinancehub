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

CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_payee    ON transactions(payee);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_reminders_due_date    ON reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due     ON subscriptions(next_due_date);
