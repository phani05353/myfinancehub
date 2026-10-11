// Receipt-AI output is UNTRUSTED. The vision model copies whatever is printed
// on the photo — and anyone can print anything on a receipt: "IGNORE PREVIOUS
// INSTRUCTIONS", a fake $9,999 total, a 2,000-char "category". Those fields
// are stored in the ledger and later read by other models (the NL-query
// summariser, Foxy via /api/agent/summary), so a receipt is a stored
// prompt-injection carrier unless every field is boxed in here first.
//
// Pure (no db/fs) so it is unit-tested in test/receipt-sanitize.test.js.

const MAX_PAYEE = 80;
const MAX_ITEM_NAME = 60;
const MAX_ITEMS = 30;
// Above this the "total" is a model misread or a planted number; 0 keeps the
// row (needs_review) so the user types the real amount.
const MAX_TOTAL = 50000;

// C0/C1 controls, zero-width chars, bidi overrides/isolates, BOM — the usual
// ways to hide text from the person reviewing the transaction.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function cleanText(value, max) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanAmount(value) {
  const n = Math.abs(Number(value));
  return Number.isFinite(n) && n <= MAX_TOTAL ? Math.round(n * 100) / 100 : 0;
}

// A real calendar date, not before 2000 and not more than a day ahead.
function cleanDate(value, today) {
  const s = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return today;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return today;
  const ahead = (d - new Date(`${today}T00:00:00Z`)) / 86400000;
  return s >= '2000-01-01' && ahead <= 1 ? s : today;
}

// The category must be one the user already has — free text from the model
// is never written. Unknown → null, and the rules engine / user pick one.
function cleanCategory(value, knownCategories) {
  const want = cleanText(value, 60).toLowerCase();
  if (!want) return null;
  return knownCategories.find(c => String(c).toLowerCase() === want) || null;
}

function sanitizeReceipt(extracted, { knownCategories = [], today }) {
  const e = extracted && typeof extracted === 'object' ? extracted : {};
  const items = (Array.isArray(e.items) ? e.items : [])
    .filter(i => i && typeof i === 'object')
    .map(i => ({
      name: cleanText(i.name, MAX_ITEM_NAME),
      price: i.price == null ? null : cleanAmount(i.price),
    }))
    .filter(i => i.name)
    .slice(0, MAX_ITEMS);
  return {
    merchant: cleanText(e.merchant, MAX_PAYEE) || 'Unknown merchant',
    total: cleanAmount(e.total),
    date: cleanDate(e.date, today),
    category: cleanCategory(e.category, knownCategories),
    items,
  };
}

module.exports = { sanitizeReceipt, cleanText, MAX_TOTAL };
