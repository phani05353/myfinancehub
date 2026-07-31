// Payee canonicalization — one merchant, one spelling.
//
// Payees reach the DB from four places (manual entry, CSV import, receipt OCR,
// subscription/reminder auto-posting) and none of them agree on casing or
// padding, so the same merchant lands as "AMAZON", "Amazon", "amazon" and
// "Amazon " — four rows in every payee dropdown, four slices in the top-payee
// chart, and four "untracked subscriptions" suggestions.
//
// Everything that writes or lists a payee goes through here:
//   normalizePayee()     — clean up one string (whitespace + edge punctuation)
//   payeeKey()           — the case-insensitive identity of a payee
//   pickCanonicalPayee() — choose the display spelling among known variants
//   resolvePayee()       — normalize, then reuse the spelling already in the DB
//   mergeLikePayees()    — one-time/periodic collapse of existing rows
//
// Only case, whitespace and edge punctuation are merged. Genuinely different
// strings ("AMZN Mktp US*2X" vs "Amazon") are left alone — collapsing those is
// a judgement call that belongs to a human, not a startup migration.

// Junk that banks pad descriptions with. Stripped from the ends only, so
// "Sam's Club #123" keeps its store number and "AT&T" keeps its ampersand.
const EDGE_JUNK = /^[\s.,;:*|/\\#-]+|[\s.,;:*|/\\#-]+$/g;

// Collapse runs of whitespace and trim edge junk. Returns '' only when the
// input was empty or pure punctuation — callers decide the fallback.
function normalizePayee(raw) {
  const cleaned = String(raw ?? '').replace(/\s+/g, ' ').replace(EDGE_JUNK, '').trim();
  // Don't hand back an empty payee for something like "***" — keep the
  // original (trimmed) text rather than losing the value entirely.
  return cleaned || String(raw ?? '').trim();
}

// Two payees are "the same" when their normalized forms match case-insensitively.
function payeeKey(raw) {
  return normalizePayee(raw).toLowerCase();
}

// How presentable a spelling is. Display quality outranks frequency below:
// bank CSVs are ALL CAPS and usually outnumber the hand-typed "Amazon", but
// SHOUTING is not what anyone wants to read in a chart legend.
//
// "AMAZON" and "amazon" rank the same — neither is nicer than the other, so the
// tiebreakers (frequency first) pick between them rather than lowercase always
// winning. Nothing here re-cases text: title-casing "IHOP" or "AT&T" by machine
// does more damage than leaving a shouty name alone.
function caseRank(s) {
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  if (hasUpper && hasLower) return /^[A-Z][a-z]/.test(s) ? 3 : 2; // Title Case, then MiXed
  return 1;                                                        // ALL CAPS or all lower
}

// Pick the spelling to keep from `[{ payee, cnt }]` variants of one merchant.
// Order: nicest casing → most used → longest → alphabetical (stable tiebreak).
function pickCanonicalPayee(variants) {
  const scored = variants
    .map(v => ({ payee: normalizePayee(v.payee), cnt: v.cnt || 0 }))
    .filter(v => v.payee);
  if (scored.length === 0) return null;

  return scored.sort((a, b) =>
    caseRank(b.payee) - caseRank(a.payee) ||
    b.cnt - a.cnt ||
    b.payee.length - a.payee.length ||
    a.payee.localeCompare(b.payee)
  )[0].payee;
}

// Normalize an incoming payee and settle it against the spellings already
// stored for that merchant, so a new "AMAZON" row joins the existing "Amazon"
// instead of starting a second group. Call this on every write path.
//
// The incoming spelling competes rather than always losing: an import row that
// finally spells a SHOUTING merchant properly wins the group and drags the old
// rows with it. Without that, the first spelling ever seen would be permanent.
function resolvePayee(db, raw) {
  const normalized = normalizePayee(raw);
  if (!normalized) return normalized;

  const existing = db.prepare(
    "SELECT payee, COUNT(*) AS cnt FROM transactions WHERE lower(payee) = lower(?) GROUP BY payee"
  ).all(normalized);
  if (existing.length === 0) return normalized;

  // cnt 0: the newcomer wins on spelling quality, never on volume.
  const canonical = pickCanonicalPayee([...existing, { payee: normalized, cnt: 0 }]) || normalized;

  const stale = existing.filter(v => v.payee !== canonical);
  if (stale.length > 0) {
    const updateTx = db.prepare('UPDATE transactions SET payee = ? WHERE payee = ?');
    for (const v of stale) updateTx.run(canonical, v.payee);
    db.prepare('UPDATE subscriptions SET payee = ? WHERE lower(payee) = lower(?)').run(canonical, canonical);
  }
  return canonical;
}

// Collapse every existing case/whitespace variant onto one spelling. Idempotent
// and cheap (one grouped scan), so it runs at startup and after each CSV import.
// Returns { groups, rows } describing what actually changed.
function mergeLikePayees(db) {
  const rows = db.prepare(
    "SELECT payee, COUNT(*) AS cnt FROM transactions WHERE payee IS NOT NULL AND payee != '' GROUP BY payee"
  ).all();

  const groups = new Map();
  for (const row of rows) {
    const key = payeeKey(row.payee);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const updateTx  = db.prepare('UPDATE transactions SET payee = ? WHERE payee = ?');
  const updateSub = db.prepare('UPDATE subscriptions SET payee = ? WHERE lower(payee) = lower(?)');

  let mergedGroups = 0, mergedRows = 0;
  const run = db.transaction(() => {
    for (const variants of groups.values()) {
      const canonical = pickCanonicalPayee(variants);
      if (!canonical) continue;

      // Keep linked subscriptions on the same spelling even when the
      // transactions themselves were already consistent.
      updateSub.run(canonical, canonical);

      const stale = variants.filter(v => v.payee !== canonical);
      if (stale.length === 0) continue;

      for (const v of stale) mergedRows += updateTx.run(canonical, v.payee).changes;
      mergedGroups++;
    }
  });
  run();

  return { groups: mergedGroups, rows: mergedRows };
}

module.exports = { normalizePayee, payeeKey, pickCanonicalPayee, resolvePayee, mergeLikePayees };
