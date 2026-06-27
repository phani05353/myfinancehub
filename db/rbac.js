// Role-based authorization policy for MyFinanceHub. Factored into its own module
// (like db/sql-safety.js) so the access matrix can be unit-tested in isolation
// without booting Express / Temporal. This is the single source of truth for
// "what may each role do" — audit the policy here, not scattered across handlers.
//
// Three roles, highest privilege wins: admin > member > viewer.
//   • admin  — everything (config + destructive ops).
//   • member — everyday finance writes (log/edit transactions, mark bills & subs
//              paid, contribute to goals, import CSV, OCR receipts). NOT config/destroy.
//   • viewer — read-only (plus the read-only "Ask" query and editing own profile).

'use strict';

const APP_ROLES = new Set(['admin', 'member', 'viewer']);

// Writes allowed for EVERY authenticated role (incl. viewer): device-local push,
// editing your own profile, and the NL "Ask" query — a POST that only ever runs a
// validated read-only SELECT (see db/sql-safety.js).
const ANY_ROLE_WRITES = [
  ['POST',   /^\/api\/query$/],
  ['POST',   /^\/api\/push\/(subscribe|unsubscribe|test)$/],
  ['POST',   /^\/auth\/profile$/],
];

// Everyday finance writes a MEMBER may perform (admins may too). DEFAULT-DENY:
// any mutating request NOT matched here (and not in ANY_ROLE_WRITES) is admin-only
// — deleting a transaction, managing rules/budgets/subscriptions/reminders/
// categories, bulk-applying rules, creating/editing/deleting goals, etc.
const MEMBER_WRITES = [
  ['POST',   /^\/api\/transactions$/],
  ['PUT',    /^\/api\/transactions\/\d+$/],
  ['POST',   /^\/api\/transactions\/\d+\/confirm$/],
  ['POST',   /^\/api\/transactions\/\d+\/receipt$/],
  ['DELETE', /^\/api\/transactions\/\d+\/receipt$/],
  ['POST',   /^\/api\/receipts\/(ocr|ingest)$/],
  ['POST',   /^\/api\/import\/csv$/],
  ['POST',   /^\/api\/subscriptions\/\d+\/pay$/],
  ['POST',   /^\/api\/reminders\/\d+\/pay$/],
  ['POST',   /^\/api\/savings-goals\/\d+\/contribute$/],
];

const matchesPolicy = (list, method, path) =>
  list.some(([m, re]) => m === method && re.test(path));

// Decide whether `role` may perform `method` on `path`. Reads (and CORS preflight)
// are open to every authenticated role; writes are governed by the tables above
// with a default-deny (admin-only) fallthrough.
function canAccess(role, method, path) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (matchesPolicy(ANY_ROLE_WRITES, method, path)) return true;
  if (role === 'admin') return true;
  if (role === 'member' && matchesPolicy(MEMBER_WRITES, method, path)) return true;
  return false;
}

// Map an Authentik `groups` claim to an app role (highest privilege wins). Group
// names are matched case-insensitively. `fallback` is the role for a user who
// matches none of the configured groups (default: least privilege, viewer).
function roleFromGroups(groups, { admin, member, viewer, fallback = 'viewer' } = {}) {
  const g = new Set((Array.isArray(groups) ? groups : []).map(x => String(x).toLowerCase()));
  if (admin  && g.has(String(admin).toLowerCase()))  return 'admin';
  if (member && g.has(String(member).toLowerCase())) return 'member';
  if (viewer && g.has(String(viewer).toLowerCase())) return 'viewer';
  return fallback;
}

module.exports = {
  APP_ROLES, ANY_ROLE_WRITES, MEMBER_WRITES, canAccess, roleFromGroups,
};
