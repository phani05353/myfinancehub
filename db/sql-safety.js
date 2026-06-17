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

  // Enforce a LIMIT so a runaway query can't return the whole table.
  if (!/\blimit\b/i.test(sql)) {
    sql = `${sql} LIMIT ${rowCap}`;
  }

  return sql;
}

module.exports = { validateReadonlySql, NLQUERY_ROW_CAP, SQL_FORBIDDEN };
