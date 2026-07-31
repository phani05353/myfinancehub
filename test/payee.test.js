// Unit tests for payee canonicalization — the rules that decide when two
// payees are "the same merchant" and which spelling survives. Run with:
//   node --test
// Uses an in-memory SQLite DB for the DB-backed helpers; no server boot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  normalizePayee, payeeKey, pickCanonicalPayee, resolvePayee, mergeLikePayees
} = require('../lib/payee');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, payee TEXT NOT NULL, category TEXT, amount REAL NOT NULL
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, payee TEXT
    );
  `);
  return db;
}

function addTx(db, payee, n = 1) {
  const stmt = db.prepare("INSERT INTO transactions (date, payee, amount) VALUES ('2026-07-01', ?, -10)");
  for (let i = 0; i < n; i++) stmt.run(payee);
}

// ── normalizePayee ────────────────────────────────────────────────────────────

test('collapses whitespace and trims edge junk', () => {
  assert.equal(normalizePayee('  Amazon   Prime  '), 'Amazon Prime');
  assert.equal(normalizePayee('*AMAZON*'), 'AMAZON');
  assert.equal(normalizePayee('Costco -'), 'Costco');
});

test('keeps punctuation that is part of the name', () => {
  assert.equal(normalizePayee("Sam's Club #123"), "Sam's Club #123");
  assert.equal(normalizePayee('AT&T'), 'AT&T');
  assert.equal(normalizePayee('7-Eleven'), '7-Eleven');
});

test('never returns empty for non-empty input', () => {
  assert.equal(normalizePayee('***'), '***');
  assert.equal(normalizePayee(''), '');
  assert.equal(normalizePayee(null), '');
});

test('payeeKey ignores case and padding', () => {
  assert.equal(payeeKey(' AMAZON '), payeeKey('amazon'));
  assert.notEqual(payeeKey('Amazon'), payeeKey('Amazon Prime'));
});

// ── pickCanonicalPayee ────────────────────────────────────────────────────────

test('prefers readable casing over raw frequency', () => {
  const winner = pickCanonicalPayee([{ payee: 'AMAZON', cnt: 50 }, { payee: 'Amazon', cnt: 2 }]);
  assert.equal(winner, 'Amazon');
});

test('falls back to frequency when casing is equally good', () => {
  const winner = pickCanonicalPayee([{ payee: 'Costco Wholesale', cnt: 3 }, { payee: 'Costco Gas', cnt: 9 }]);
  assert.equal(winner, 'Costco Gas');
});

test('between two uniform-case spellings, the common one wins', () => {
  assert.equal(pickCanonicalPayee([{ payee: 'KROGER', cnt: 10 }, { payee: 'kroger', cnt: 1 }]), 'KROGER');
  assert.equal(pickCanonicalPayee([{ payee: 'KROGER', cnt: 1 }, { payee: 'kroger', cnt: 10 }]), 'kroger');
});

test('a single Title Case sighting still beats a common shouty spelling', () => {
  assert.equal(pickCanonicalPayee([{ payee: 'KROGER', cnt: 40 }, { payee: 'Kroger', cnt: 1 }]), 'Kroger');
});

// ── resolvePayee ──────────────────────────────────────────────────────────────

test('snaps a new spelling onto the one already stored', () => {
  const db = freshDb();
  addTx(db, 'Amazon', 3);
  assert.equal(resolvePayee(db, 'AMAZON'), 'Amazon');
  assert.equal(resolvePayee(db, '  amazon  '), 'Amazon');
});

test('leaves a genuinely new merchant alone (just cleaned up)', () => {
  const db = freshDb();
  addTx(db, 'Amazon', 3);
  assert.equal(resolvePayee(db, '  Trader   Joes '), 'Trader Joes');
});

test('a better-spelled newcomer wins and pulls the stored rows with it', () => {
  const db = freshDb();
  addTx(db, 'COSTCO WHOLESALE', 4);

  assert.equal(resolvePayee(db, 'Costco Wholesale'), 'Costco Wholesale');
  const spellings = db.prepare('SELECT DISTINCT payee FROM transactions').all().map(r => r.payee);
  assert.deepEqual(spellings, ['Costco Wholesale']);
});

test('a worse-spelled newcomer loses and leaves stored rows untouched', () => {
  const db = freshDb();
  addTx(db, 'Costco Wholesale', 1);

  assert.equal(resolvePayee(db, 'COSTCO WHOLESALE'), 'Costco Wholesale');
  const spellings = db.prepare('SELECT DISTINCT payee FROM transactions').all().map(r => r.payee);
  assert.deepEqual(spellings, ['Costco Wholesale']);
});

// ── mergeLikePayees ───────────────────────────────────────────────────────────

test('collapses case and whitespace variants onto one spelling', () => {
  const db = freshDb();
  addTx(db, 'AMAZON', 5);
  addTx(db, 'Amazon', 2);
  addTx(db, 'amazon ', 1);

  const out = mergeLikePayees(db);
  assert.equal(out.groups, 1);
  assert.equal(out.rows, 6);

  const spellings = db.prepare('SELECT DISTINCT payee FROM transactions').all().map(r => r.payee);
  assert.deepEqual(spellings, ['Amazon']);
});

test('does not merge merchants that differ by more than case', () => {
  const db = freshDb();
  addTx(db, 'Amazon');
  addTx(db, 'AMZN Mktp US*2X');

  mergeLikePayees(db);
  const count = db.prepare('SELECT COUNT(DISTINCT payee) AS c FROM transactions').get().c;
  assert.equal(count, 2);
});

test('is idempotent — a second pass changes nothing', () => {
  const db = freshDb();
  addTx(db, 'KROGER', 4);
  addTx(db, 'Kroger', 1);

  mergeLikePayees(db);
  const second = mergeLikePayees(db);
  assert.equal(second.groups, 0);
  assert.equal(second.rows, 0);
});

test('drags linked subscriptions onto the same spelling', () => {
  const db = freshDb();
  addTx(db, 'NETFLIX', 4);
  addTx(db, 'Netflix', 1);
  db.prepare("INSERT INTO subscriptions (name, payee) VALUES ('Netflix', 'NETFLIX')").run();

  mergeLikePayees(db);
  assert.equal(db.prepare('SELECT payee FROM subscriptions').get().payee, 'Netflix');
});
