// Unit tests for the read-only SQL safety validator (the highest-risk piece of
// the natural-language query feature). Run with: node --test
// No DB or server boot required — the validator is pure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReadonlySql, NLQUERY_ROW_CAP } = require('../db/sql-safety');

// ── Accepts legitimate reads ──────────────────────────────────────────────────

test('accepts a plain SELECT and enforces a LIMIT', () => {
  const out = validateReadonlySql('SELECT category, SUM(ABS(amount)) AS total FROM transactions WHERE amount < 0 GROUP BY category');
  assert.match(out, /^SELECT/i);
  assert.match(out, new RegExp(`LIMIT ${NLQUERY_ROW_CAP}$`));
});

test('keeps an existing LIMIT untouched', () => {
  const out = validateReadonlySql('SELECT * FROM transactions LIMIT 10');
  assert.equal(out, 'SELECT * FROM transactions LIMIT 10');
});

test('accepts a WITH ... SELECT (CTE)', () => {
  const out = validateReadonlySql(
    "WITH monthly AS (SELECT strftime('%Y-%m', date) m, SUM(amount) s FROM transactions GROUP BY m) SELECT * FROM monthly"
  );
  assert.match(out, /^WITH/i);
  assert.match(out, /LIMIT/i);
});

test('strips ```sql code fences and a trailing semicolon', () => {
  const out = validateReadonlySql('```sql\nSELECT 1 AS one;\n```');
  assert.equal(out, 'SELECT 1 AS one LIMIT ' + NLQUERY_ROW_CAP);
});

test('is case-insensitive about the SELECT keyword', () => {
  const out = validateReadonlySql('select payee from transactions limit 5');
  assert.equal(out, 'select payee from transactions limit 5');
});

// Regression (bug-NNN): gemma3:4b wraps output in ```sqlite (not ```sql), and the
// old stripper left "ite\nSELECT…" → falsely "not a SELECT". Any language tag must
// be stripped, with or without the closing fence.
test('strips a ```sqlite fence (any language tag)', () => {
  const out = validateReadonlySql('```sqlite\nSELECT category FROM transactions\n```');
  assert.equal(out, 'SELECT category FROM transactions LIMIT ' + NLQUERY_ROW_CAP);
});

test('strips an opening fence even when the closing fence is missing', () => {
  const out = validateReadonlySql('```sqlite\n\nSELECT 1 AS one');
  assert.equal(out, 'SELECT 1 AS one LIMIT ' + NLQUERY_ROW_CAP);
});

test('extracts SQL from a fenced block surrounded by prose', () => {
  const out = validateReadonlySql('Sure!\n```sql\nSELECT 1 AS one\n```\nHope that helps.');
  assert.equal(out, 'SELECT 1 AS one LIMIT ' + NLQUERY_ROW_CAP);
});

// ── Rejects writes / DDL / side effects ───────────────────────────────────────

const REJECTS = {
  'INSERT': "INSERT INTO transactions (payee, amount) VALUES ('x', -5)",
  'UPDATE': "UPDATE transactions SET amount = 0 WHERE id = 1",
  'DELETE': 'DELETE FROM transactions',
  'DROP': 'DROP TABLE transactions',
  'ALTER': 'ALTER TABLE transactions ADD COLUMN hacked TEXT',
  'CREATE': 'CREATE TABLE evil (x)',
  'REPLACE': "REPLACE INTO categories (name) VALUES ('x')",
  'ATTACH': "ATTACH DATABASE 'other.db' AS o",
  'PRAGMA': 'PRAGMA table_info(users)',
  'VACUUM': 'VACUUM',
  'trigger': 'CREATE TRIGGER t AFTER INSERT ON transactions BEGIN SELECT 1; END'
};

for (const [label, sql] of Object.entries(REJECTS)) {
  test(`rejects ${label}`, () => {
    assert.throws(() => validateReadonlySql(sql));
  });
}

// ── Rejects multi-statement / injection shapes ────────────────────────────────

test('rejects a second statement after a SELECT', () => {
  assert.throws(
    () => validateReadonlySql('SELECT 1; DROP TABLE transactions'),
    /single statement/i
  );
});

test('rejects a stacked write hidden after a semicolon', () => {
  assert.throws(
    () => validateReadonlySql("SELECT * FROM transactions; DELETE FROM users;"),
    /single statement/i
  );
});

test('rejects SQL line comments', () => {
  assert.throws(() => validateReadonlySql('SELECT 1 -- DROP TABLE transactions'), /comment/i);
});

test('rejects SQL block comments', () => {
  assert.throws(() => validateReadonlySql('SELECT /* sneaky */ 1'), /comment/i);
});

test('rejects non-SELECT leading statement', () => {
  assert.throws(() => validateReadonlySql('EXPLAIN SELECT 1'), /SELECT/i);
});

test('rejects empty / non-string input', () => {
  assert.throws(() => validateReadonlySql(''));
  assert.throws(() => validateReadonlySql(null));
  assert.throws(() => validateReadonlySql(undefined));
});
