// Slack mirror for the monthly-report email (Incoming Webhook + Block Kit).
//
// The month-end report we email is ALSO posted to Slack when SLACK_WEBHOOK_URL
// is set. It's a *mirror*, not a replacement: best-effort by contract — a Slack
// outage (or an unset webhook) is swallowed and the email still sends.
//
// Slack can't render the HTML email body, so htmlToMrkdwn() boils the HTML down
// to readable Slack mrkdwn and buildBlocks() lays it out as a "card" using Block
// Kit (Slack's equivalent of an Adaptive Card): a header, a context line, a
// divider, then the body in one or more section blocks.

// Block Kit hard limits we stay under.
const HEADER_MAX = 150; // header plain_text
const SECTION_MAX = 2900; // section mrkdwn (Slack caps at 3000; leave headroom)
const MAX_SECTIONS = 20; // don't post an essay; truncate the tail

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
};

function unescapeHtml(s) {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] || m);
}

// Convert an HTML email body into readable Slack mrkdwn (best-effort heuristic).
function htmlToMrkdwn(html) {
  let s = html || '';
  // Drop non-content blocks wholesale (styles/scripts/head leak CSS otherwise).
  s = s.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '');
  // Links: <a href="URL">text</a> -> <URL|text>
  s = s.replace(/<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, text) => {
    const label = text.replace(/<[^>]+>/g, '').trim();
    const href = url.trim();
    if (!href) return label;
    return label ? `<${href}|${label}>` : `<${href}>`;
  });
  // Headings -> bold on their own line.
  s = s.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n*$1*\n');
  // Bold / italic.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '_$2_');
  // List items -> bullets.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '• $1\n');
  // Block-level breaks -> newline.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|table|ul|ol|h[1-6])>/gi, '\n');
  // Strip every remaining tag, then unescape entities.
  s = s.replace(/<[^>]+>/g, '');
  s = unescapeHtml(s);
  // Tidy whitespace: trim each line, collapse 3+ blank lines to one blank.
  s = s
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// Split text into <=size pieces, preferring paragraph/line boundaries.
function chunk(text, size) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > size) {
    const window = remaining.slice(0, size);
    let cut = window.lastIndexOf('\n\n');
    if (cut < size / 2) cut = window.lastIndexOf('\n');
    if (cut < size / 2) cut = size;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Lay out a subject + HTML body as a Block Kit "card".
function buildBlocks(subject, html, source = '💰 MyFinanceHub') {
  const body = htmlToMrkdwn(html) || '_(no details)_';
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: subject.slice(0, HEADER_MAX), emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: source }] },
    { type: 'divider' }
  ];
  let pieces = chunk(body, SECTION_MAX);
  if (pieces.length > MAX_SECTIONS) {
    pieces = pieces.slice(0, MAX_SECTIONS);
    pieces[pieces.length - 1] =
      pieces[pieces.length - 1].trimEnd() + '\n\n_…truncated — see the email for the full report._';
  }
  for (const piece of pieces) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: piece } });
  }
  return blocks;
}

// Post the alert to Slack via Incoming Webhook. Returns true on success.
// Best-effort: returns false (never throws) when the webhook is unset or Slack
// rejects the post, so the caller's email is never affected.
async function postToSlack(webhookUrl, subject, html, source = '💰 MyFinanceHub') {
  if (!webhookUrl) return false;
  const payload = {
    text: subject, // plain fallback for notifications / screen readers
    blocks: buildBlocks(subject, html, source)
  };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch (_) {
    return false; // mirror is best-effort; caller logs.
  }
}

module.exports = { htmlToMrkdwn, buildBlocks, postToSlack };
