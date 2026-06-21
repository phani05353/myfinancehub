// Read-only SQL safety validator for the natural-language query feature.
// Factored into its own module so it can be unit-tested in isolation without
// booting the Express server / Temporal worker. The LLM output that flows through
// here is UNTRUSTED — this is the highest-risk piece of /api/query.

// Hard cap on rows a single NL query may return.
const NLQUERY_ROW_CAP = 500;

// Statements/keywords that must NEVER appear in LLM-generated SQL. Belt-and-
// suspenders on top of the readonly DB connection: reject anything not a pure read.
const SQL_FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'replace',
  'attach', 'detach', 'pragma', 'vacuum', 'reindex', 'analyze',
  'truncate', 'grant', 'revoke', 'commit', 'rollback', 'begin',
  'savepoint', 'release', 'trigger'
];

// The ONLY tables an NL query may read. The read-only DB handle can physically
// see the whole finance.db file — which also holds `app_settings` (session_secret,
// vapid_private), the `sessions` store, `users` (oidc_sub/email) and
// `push_subscriptions`. A SELECT is still a SELECT, so without this allow-list a
// crafted question could exfiltrate those secrets/PII. The prompt's "only these
// tables" hint is NOT a security boundary — this is. (Default-deny.)
const ALLOWED_TABLES = new Set([
  'transactions', 'budgets', 'subscriptions', 'reminders', 'categories'
]);

// Identifiers that must NEVER be referenced, matched anywhere as a backstop in
// case the FROM/JOIN extraction misses an exotic construct. Covers the secret/PII
// tables plus SQLite's internal schema tables (sqlite_master/_schema/etc.).
const SQL_DENY_IDENTIFIERS = /\b(?:app_settings|sessions|users|push_subscriptions|sqlite_[a-z_]*)\b/i;

// Validate that a string is a SINGLE read-only SELECT statement. Returns the
// cleaned SQL (with a LIMIT enforced) or throws with a clear reason.
function validateReadonlySql(rawSql, { rowCap = NLQUERY_ROW_CAP } = {}) {
  if (!rawSql || typeof rawSql !== 'string') throw new Error('No SQL produced');

  // Models often wrap output in a fenced block (```sql / ```sqlite / bare ```),
  // and small models sometimes prepend prose ("Here is the query:"). Extract the
  // SQL robustly: prefer the contents of the first fenced block; otherwise strip
  // any stray leading/trailing fence (with an optional language tag).
  let sql = rawSql.trim();
  const fenced = sql.match(/```[\w-]*\s*([\s\S]*?)```/);
  if (fenced) {
    sql = fenced[1].trim();
  } else {
    sql = sql.replace(/^```[\w-]*[ \t]*\r?\n?/i, '').replace(/\s*```\s*$/i, '').trim();
  }

  // Remove a single trailing semicolon, then ensure no OTHER statement follows.
  sql = sql.replace(/;\s*$/, '').trim();
  if (!sql) throw new Error('Empty SQL');

  // Reject SQL comments — they can hide a second statement or mask keywords.
  if (/--/.test(sql) || /\/\*/.test(sql)) {
    throw new Error('SQL comments are not allowed');
  }

  // Exactly one statement: no semicolons may remain anywhere in the body.
  if (sql.includes(';')) throw new Error('Only a single statement is allowed');

  // Must be a read: start with SELECT, or a CTE (WITH ... that contains SELECT).
  const head = sql.replace(/^\(+/, '').trimStart().toLowerCase();
  const startsSelect = head.startsWith('select');
  const startsWith   = head.startsWith('with');
  if (!startsSelect && !startsWith) {
    throw new Error('Query must be a single SELECT (or WITH … SELECT) statement');
  }
  if (startsWith && !/\bselect\b/i.test(sql)) {
    throw new Error('WITH clause must contain a SELECT');
  }

  // Forbid any write/DDL/side-effecting keyword anywhere (word-boundary matched).
  for (const kw of SQL_FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(sql)) {
      throw new Error(`Disallowed keyword in query: ${kw.toUpperCase()}`);
    }
  }

  // Analyse a copy with single-quoted STRING LITERALS blanked, so a value like
  // payee = 'session users' can't trip the table checks below. (In SQLite single
  // quotes are strings; double quotes are identifiers — so real table refs, quoted
  // or not, are still seen.)
  const analyzable = sql.replace(/'(?:[^']|'')*'/g, "''");

  // Backstop: hard-reject any reference to a secret/PII/internal identifier,
  // matched anywhere. Catches constructs the FROM/JOIN scan below might miss
  // (e.g. comma joins: FROM transactions, users).
  if (SQL_DENY_IDENTIFIERS.test(analyzable)) {
    throw new Error('Query references a table that is not allowed');
  }

  // Default-deny table allow-list: every real table read via FROM/JOIN must be in
  // ALLOWED_TABLES. CTE names (WITH x AS (...)) are query-local aliases, not real
  // tables, so they're permitted. This is the boundary that stops a crafted SELECT
  // from reaching users/app_settings/sessions/etc. even though it's a valid read.
  const cteNames = new Set(
    [...analyzable.matchAll(/(?:\bwith\b|,)\s*([a-z_][\w$]*)\s+as\s*\(/gi)].map(m => m[1].toLowerCase())
  );
  for (const m of analyzable.matchAll(/\b(?:from|join)\s+([a-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])/gi)) {
    const ref = m[1].replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
    if (!ALLOWED_TABLES.has(ref) && !cteNames.has(ref)) {
      throw new Error(`Query may only read these tables: ${[...ALLOWED_TABLES].join(', ')}`);
    }
  }

  // Enforce a LIMIT so a runaway query can't return the whole table.
  if (!/\blimit\b/i.test(sql)) {
    sql = `${sql} LIMIT ${rowCap}`;
  }

  return sql;
}

module.exports = { validateReadonlySql, NLQUERY_ROW_CAP, SQL_FORBIDDEN, ALLOWED_TABLES };
