// Unit tests for the role-based authorization policy (db/rbac.js). This is a
// security boundary, so the matrix is pinned here: a future change that loosens
// a write for the wrong role — or a typo'd path regex — should fail a test.
// Run with: node --test  (no DB or server boot required — the policy is pure.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canAccess, roleFromGroups } = require('../db/rbac');

// ── Reads are open to every authenticated role ────────────────────────────────

test('all roles can read (GET)', () => {
  for (const role of ['admin', 'member', 'viewer']) {
    assert.equal(canAccess(role, 'GET', '/api/transactions'), true);
    assert.equal(canAccess(role, 'GET', '/api/year-review/2026'), true);
    assert.equal(canAccess(role, 'HEAD', '/api/budgets'), true);
  }
});

// ── Writes allowed for every role (incl. viewer) ──────────────────────────────

test('every role may use the read-only "Ask" query, push, and own profile', () => {
  for (const role of ['admin', 'member', 'viewer']) {
    assert.equal(canAccess(role, 'POST', '/api/query'), true);
    assert.equal(canAccess(role, 'POST', '/api/push/subscribe'), true);
    assert.equal(canAccess(role, 'POST', '/api/push/unsubscribe'), true);
    assert.equal(canAccess(role, 'POST', '/api/push/test'), true);
    assert.equal(canAccess(role, 'POST', '/auth/profile'), true);
  }
});

// ── Member: everyday writes allowed ───────────────────────────────────────────

test('member can do everyday finance writes', () => {
  const allowed = [
    ['POST',   '/api/transactions'],
    ['PUT',    '/api/transactions/42'],
    ['POST',   '/api/transactions/42/confirm'],
    ['POST',   '/api/transactions/42/receipt'],
    ['DELETE', '/api/transactions/42/receipt'],
    ['POST',   '/api/receipts/ocr'],
    ['POST',   '/api/receipts/ingest'],
    ['POST',   '/api/import/csv'],
    ['POST',   '/api/subscriptions/3/pay'],
    ['POST',   '/api/reminders/3/pay'],
    ['POST',   '/api/savings-goals/3/contribute'],
  ];
  for (const [m, p] of allowed) {
    assert.equal(canAccess('member', m, p), true, `member should be allowed ${m} ${p}`);
    assert.equal(canAccess('admin', m, p), true, `admin should be allowed ${m} ${p}`);
  }
});

// ── Member: config/destructive writes DENIED (admin-only, default-deny) ────────

test('member is denied config/destructive writes; admin allowed', () => {
  const adminOnly = [
    ['DELETE', '/api/transactions/42'],       // deleting a transaction
    ['POST',   '/api/budgets'],
    ['DELETE', '/api/budgets/1'],
    ['POST',   '/api/savings-goals'],          // create goal (vs /contribute)
    ['PUT',    '/api/savings-goals/1'],
    ['DELETE', '/api/savings-goals/1'],
    ['POST',   '/api/categories'],
    ['DELETE', '/api/categories/Groceries'],
    ['POST',   '/api/subscriptions'],          // create sub (vs /pay)
    ['PUT',    '/api/subscriptions/1'],
    ['DELETE', '/api/subscriptions/1'],
    ['POST',   '/api/reminders'],              // create reminder (vs /pay)
    ['PUT',    '/api/reminders/1'],
    ['DELETE', '/api/reminders/1'],
    ['POST',   '/api/rules'],
    ['PUT',    '/api/rules/1'],
    ['DELETE', '/api/rules/1'],
    ['POST',   '/api/rules/apply'],
  ];
  for (const [m, p] of adminOnly) {
    assert.equal(canAccess('member', m, p), false, `member should be DENIED ${m} ${p}`);
    assert.equal(canAccess('viewer', m, p), false, `viewer should be DENIED ${m} ${p}`);
    assert.equal(canAccess('admin', m, p), true, `admin should be allowed ${m} ${p}`);
  }
});

// ── Viewer: no everyday writes either ─────────────────────────────────────────

test('viewer cannot perform member-level writes', () => {
  assert.equal(canAccess('viewer', 'POST', '/api/transactions'), false);
  assert.equal(canAccess('viewer', 'PUT', '/api/transactions/1'), false);
  assert.equal(canAccess('viewer', 'POST', '/api/import/csv'), false);
  assert.equal(canAccess('viewer', 'POST', '/api/subscriptions/1/pay'), false);
});

// ── Unknown / unmatched write paths default-deny to admin-only ────────────────

test('an unlisted write path is admin-only (default-deny)', () => {
  assert.equal(canAccess('member', 'POST', '/api/some-future-endpoint'), false);
  assert.equal(canAccess('viewer', 'POST', '/api/some-future-endpoint'), false);
  assert.equal(canAccess('admin', 'POST', '/api/some-future-endpoint'), true);
});

// ── A typo'd sub-path must NOT match a member write (regex anchoring) ──────────

test('member write regexes are anchored (no partial/path-prefix matches)', () => {
  // Non-numeric id, trailing junk, and prefix tricks should all fall through to deny.
  assert.equal(canAccess('member', 'PUT', '/api/transactions/42/evil'), false);
  assert.equal(canAccess('member', 'POST', '/api/transactions/abc'), false);
  assert.equal(canAccess('member', 'POST', '/api/queryX'), false);
  assert.equal(canAccess('member', 'POST', '/api/transactionsX'), false);
});

// ── roleFromGroups: Authentik group → role (highest privilege wins) ───────────

const MAP = { admin: 'finance-admins', member: 'finance-members', viewer: 'finance-viewers', fallback: 'viewer' };

test('roleFromGroups maps groups to roles, highest privilege wins', () => {
  assert.equal(roleFromGroups(['finance-admins'], MAP), 'admin');
  assert.equal(roleFromGroups(['finance-members'], MAP), 'member');
  assert.equal(roleFromGroups(['finance-viewers'], MAP), 'viewer');
  // Highest privilege wins when in multiple groups.
  assert.equal(roleFromGroups(['finance-viewers', 'finance-admins'], MAP), 'admin');
  assert.equal(roleFromGroups(['finance-viewers', 'finance-members'], MAP), 'member');
});

test('roleFromGroups is case-insensitive and falls back when no group matches', () => {
  assert.equal(roleFromGroups(['FINANCE-ADMINS'], MAP), 'admin');
  assert.equal(roleFromGroups(['unrelated-group'], MAP), 'viewer');   // fallback
  assert.equal(roleFromGroups([], MAP), 'viewer');                    // fallback
  assert.equal(roleFromGroups(undefined, MAP), 'viewer');             // fallback
  // Custom fallback respected.
  assert.equal(roleFromGroups([], { ...MAP, fallback: 'member' }), 'member');
});
