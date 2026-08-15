// Monthly report email — renderer only. Pure functions, no I/O.
// Produces an inline-styled, table-based HTML email that survives the major
// mail clients (Gmail, Apple Mail, Outlook, Yahoo). Dark mode in email is
// unreliable, so this is a clean light card with the app's accent color.

const ACCENT = '#6c8ef5';
const INK = '#1a1d24';
const MUTED = '#6b7280';
const BORDER = '#e6e8ec';
const BG = '#f4f5f7';
const CARD = '#ffffff';
const POS = '#15a36e';
const NEG = '#e05656';

const money = (n) =>
  '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
const money0 = (n) =>
  '$' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function monthlyReportSubject(d) {
  const sign = d.net >= 0 ? '+' : '-';
  return `Your ${d.monthLabel} Finance Report — net ${sign}${money0(d.net)}`;
}

// One stat tile in the hero grid.
function statTile(label, value, color) {
  return `
    <td width="33.33%" valign="top" style="padding:0 6px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="background:${CARD};border:1px solid ${BORDER};border-radius:12px">
        <tr><td style="padding:16px 14px;text-align:center">
          <div style="font:600 11px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">${esc(label)}</div>
          <div style="margin-top:8px;font:700 22px/1.1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${color || INK}">${value}</div>
        </td></tr>
      </table>
    </td>`;
}

// A labeled horizontal bar (category breakdown).
function barRow(label, amount, pct, color) {
  const w = Math.max(2, Math.min(100, Math.round(pct)));
  return `
    <tr>
      <td style="padding:9px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font:600 13px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">${esc(label)}</td>
            <td align="right" style="font:600 13px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};white-space:nowrap">${money(amount)}</td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">
          <tr><td style="background:${BORDER};border-radius:6px;height:8px;line-height:8px;font-size:0">
            <table role="presentation" width="${w}%" cellpadding="0" cellspacing="0"><tr>
              <td style="background:${color || ACCENT};border-radius:6px;height:8px;line-height:8px;font-size:0">&nbsp;</td>
            </tr></table>
          </td></tr>
        </table>
      </td>
    </tr>`;
}

function sectionTitle(text) {
  return `<div style="margin:28px 0 12px;font:700 15px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">${esc(text)}</div>`;
}

function monthlyReportHtml(d) {
  const netColor = d.net >= 0 ? POS : NEG;
  const netSign = d.net >= 0 ? '+' : '−';

  // Spending vs previous month chip
  let trendChip = '';
  if (d.spentDeltaPct != null) {
    const up = d.spentDeltaPct > 0;
    const c = up ? NEG : POS;
    trendChip = `<span style="display:inline-block;margin-left:8px;padding:3px 9px;border-radius:999px;background:${up ? '#fdeaea' : '#e7f6ef'};color:${c};font:600 12px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">${up ? '▲' : '▼'} ${Math.abs(d.spentDeltaPct).toFixed(0)}% vs last month</span>`;
  }

  const catRows = (d.topCategories || [])
    .map((c) => barRow(c.cat, c.total, c.pct, ACCENT))
    .join('');

  const merchantRows = (d.topMerchants || [])
    .map(
      (m) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${BORDER};font:600 13px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">${esc(m.payee)}<span style="color:${MUTED};font-weight:500"> · ${m.cnt}×</span></td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid ${BORDER};font:700 13px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">${money(m.total)}</td>
      </tr>`
    )
    .join('');

  const bigRows = (d.biggestExpenses || [])
    .map(
      (t) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${BORDER};font:600 13px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">${esc(t.payee)}<div style="color:${MUTED};font-weight:500;font-size:12px;margin-top:2px">${esc(t.date)}${t.category ? ' · ' + esc(t.category) : ''}</div></td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid ${BORDER};font:700 13px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${NEG};white-space:nowrap">${money(t.amount)}</td>
      </tr>`
    )
    .join('');

  const budgetRows = (d.budgets || [])
    .map((b) => {
      const over = b.pct >= 100;
      const near = b.pct >= 80;
      const c = over ? NEG : near ? '#d99a16' : POS;
      return barRow(`${b.category} — ${b.pct.toFixed(0)}% of ${money0(b.budget)}`, b.spent, b.pct, c);
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(d.monthLabel)} Finance Report</title></head>
<body style="margin:0;padding:0;background:${BG};-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Header -->
  <tr><td style="background:${ACCENT};background:linear-gradient(135deg,#6c8ef5 0%,#8a6cf5 100%);border-radius:16px 16px 0 0;padding:30px 28px">
    <div style="font:600 13px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:rgba(255,255,255,.85);letter-spacing:.04em">MYFINANCEHUB</div>
    <div style="margin-top:6px;font:700 26px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#fff">${esc(d.monthLabel)} Report</div>
    <div style="margin-top:4px;font:500 14px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:rgba(255,255,255,.9)">${d.txCount} transactions this month</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:${BG};padding:24px 22px 30px">

    <!-- Hero: net result -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:12px">
      <tr><td style="padding:22px;text-align:center">
        <div style="font:600 11px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">Net for ${esc(d.monthLabel)}</div>
        <div style="margin-top:8px;font:800 38px/1.1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${netColor}">${netSign}${money(d.net)}</div>
        ${d.savingsRate != null ? `<div style="margin-top:6px;font:600 13px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED}">${d.savingsRate >= 0 ? d.savingsRate.toFixed(0) + '% savings rate' : 'Spent more than earned'}</div>` : ''}
        <div style="margin-top:10px">${trendChip}</div>
      </td></tr>
    </table>

    <!-- Stat tiles -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr>
      ${statTile('Income', money0(d.income), POS)}
      ${statTile('Spent', money0(d.spent), NEG)}
      ${statTile('Avg / day', money0(d.avgDaily), INK)}
    </tr></table>

    ${catRows ? sectionTitle('Top spending categories') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:12px"><tr><td style="padding:6px 18px 14px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${catRows}</table>
      </td></tr></table>` : ''}

    ${merchantRows ? sectionTitle('Top merchants') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:12px"><tr><td style="padding:4px 18px 8px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${merchantRows}</table>
      </td></tr></table>` : ''}

    ${bigRows ? sectionTitle('Biggest expenses') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:12px"><tr><td style="padding:4px 18px 8px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bigRows}</table>
      </td></tr></table>` : ''}

    ${budgetRows ? sectionTitle('Budget performance') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:12px"><tr><td style="padding:6px 18px 14px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${budgetRows}</table>
      </td></tr></table>` : ''}

  </td></tr>

  <!-- Footer -->
  <tr><td style="background:${CARD};border-top:1px solid ${BORDER};border-radius:0 0 16px 16px;padding:20px 22px;text-align:center">
    <div style="font:500 12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED}">
      Automated month-end summary from your self-hosted MyFinanceHub.<br>Generated ${esc(d.today)}.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

module.exports = { monthlyReportHtml, monthlyReportSubject };
