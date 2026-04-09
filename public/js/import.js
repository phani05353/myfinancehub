const importModule = {
  async init() {
    // Build last 24 months for export picker
    const monthOptions = [];
    const d = new Date();
    for (let i = 0; i < 24; i++) {
      const val   = d.toISOString().slice(0, 7);
      const label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
      monthOptions.push(`<option value="${val}" ${i === 0 ? 'selected' : ''}>${label}</option>`);
      d.setMonth(d.getMonth() - 1);
    }

    document.getElementById('view').innerHTML = `
      <h1 style="margin-bottom:20px">Import &amp; Export</h1>

      <!-- ── IMPORT ───────────────────────────────────────────────── -->
      <div class="card" style="margin-bottom:20px">
        <h2 style="margin-bottom:4px">Import Transactions</h2>
        <p style="color:var(--text-muted);margin-bottom:16px;line-height:1.6;font-size:13px">
          Upload a CSV file from your bank or any finance app.
          Duplicate transactions are automatically skipped.
        </p>

        <div style="background:var(--surface2);border-radius:8px;padding:14px;margin-bottom:20px;font-size:12px;color:var(--text-muted)">
          <strong style="color:var(--text)">Supported Formats</strong>
          <ul style="margin:8px 0 0 16px;line-height:2">
            <li>Generic bank CSV: <code>Date, Description/Merchant, Amount</code></li>
            <li>Full format: <code>Date, Payee, Category, Amount, Notes</code></li>
            <li>Date formats: <code>MM/DD/YYYY</code> or <code>YYYY-MM-DD</code></li>
            <li>Amount: negative = expense, positive = income</li>
          </ul>
        </div>

        <form id="import-form">
          <div class="drop-zone" id="drop-zone" onclick="document.getElementById('csv-file').click()">
            <div class="drop-icon">📂</div>
            <div style="font-size:16px;font-weight:600;margin-bottom:8px">Drop CSV file here or click to browse</div>
            <div style="font-size:12px;color:var(--text-muted)">Supports .csv files</div>
            <input type="file" id="csv-file" accept=".csv,text/csv" style="display:none">
          </div>

          <div id="file-preview" style="display:none;margin-top:12px;padding:12px;background:var(--surface2);border-radius:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span id="file-name" style="font-weight:600"></span>
              <button type="button" class="btn btn-ghost btn-sm" onclick="importModule.clearFile()">✕ Remove</button>
            </div>
          </div>

          <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
            <button type="submit" id="import-btn" class="btn btn-primary" disabled>Import Transactions</button>
            <span id="import-status" style="color:var(--text-muted);font-size:13px"></span>
          </div>
        </form>

        <div id="import-result"></div>
      </div>

      <!-- ── EXPORT ───────────────────────────────────────────────── -->
      <div class="card">
        <h2 style="margin-bottom:4px">Export Data</h2>
        <p style="color:var(--text-muted);margin-bottom:20px;font-size:13px;line-height:1.6">
          Download your transactions as a CSV or generate a printable PDF monthly report.
        </p>

        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">Month</label>
            <select id="export-month" class="tx-filter-select" style="min-width:180px">
              <option value="">All time</option>
              ${monthOptions.join('')}
            </select>
          </div>
        </div>

        <div class="export-btn-row" style="display:flex;gap:12px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="importModule.exportCSV()">
            ⬇ Download CSV
          </button>
          <button class="btn btn-ghost" onclick="importModule.exportPDF()">
            🖨 Export PDF Report
          </button>
        </div>
        <p style="margin-top:12px;font-size:12px;color:var(--text-muted)">
          PDF opens a print-ready report in a new tab — use your browser's Save as PDF option.
        </p>
      </div>
    `;

    const fileInput = document.getElementById('csv-file');
    const dropZone  = document.getElementById('drop-zone');
    const form      = document.getElementById('import-form');

    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) this.setFile(e.target.files[0]);
    });
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && (file.name.endsWith('.csv') || file.type === 'text/csv')) {
        this.setFile(file);
      } else {
        toast('Please drop a CSV file', 'error');
      }
    });
    form.onsubmit = e => { e.preventDefault(); this.doImport(); };
  },

  setFile(file) {
    document.getElementById('file-name').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    document.getElementById('file-preview').style.display = 'block';
    document.getElementById('import-btn').disabled = false;
    this._file = file;
  },

  clearFile() {
    this._file = null;
    document.getElementById('file-preview').style.display = 'none';
    document.getElementById('csv-file').value = '';
    document.getElementById('import-btn').disabled = true;
    document.getElementById('import-result').innerHTML = '';
  },

  async doImport() {
    if (!this._file) return;
    const btn    = document.getElementById('import-btn');
    const status = document.getElementById('import-status');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    status.textContent = '';

    const formData = new FormData();
    formData.append('csvfile', this._file);

    try {
      const res    = await fetch('/api/import/csv', { method: 'POST', body: formData });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);

      const hasErrors = result.errors && result.errors.length > 0;
      document.getElementById('import-result').innerHTML = `
        <div class="import-result ${hasErrors && result.imported === 0 ? 'error' : 'success'}">
          <div style="font-size:16px;font-weight:700;margin-bottom:8px">
            ${result.imported === 0 && hasErrors ? '❌ Import failed' : '✅ Import complete'}
          </div>
          <div style="display:flex;gap:24px;margin-bottom:${hasErrors ? '12px' : '0'}">
            <div><strong style="color:var(--success)">${result.imported}</strong> <span style="color:var(--text-muted)">imported</span></div>
            <div><strong style="color:var(--text-muted)">${result.skipped}</strong> <span style="color:var(--text-muted)">skipped (duplicates)</span></div>
            ${hasErrors ? `<div><strong style="color:var(--danger)">${result.errors.length}</strong> <span style="color:var(--text-muted)">errors</span></div>` : ''}
          </div>
          ${hasErrors ? `
            <details style="margin-top:8px">
              <summary style="cursor:pointer;color:var(--danger);font-size:12px">Show ${result.errors.length} error(s)</summary>
              <ul style="margin:8px 0 0 16px;font-size:11px;color:var(--text-muted)">
                ${result.errors.map(e => `<li>Row ${e.row}: ${escHtml(e.error)}</li>`).join('')}
              </ul>
            </details>
          ` : ''}
        </div>
      `;
      if (result.imported > 0) {
        toast(`Imported ${result.imported} transaction${result.imported !== 1 ? 's' : ''}`);
        this.clearFile();
      }
    } catch (e) {
      toast(e.message, 'error');
      document.getElementById('import-result').innerHTML = `
        <div class="import-result error"><strong>Error:</strong> ${escHtml(e.message)}</div>
      `;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import Transactions';
    }
  },

  exportCSV() {
    const month = document.getElementById('export-month').value;
    const url   = '/api/export/csv' + (month ? `?month=${month}` : '');
    window.location.href = url;
  },

  async exportPDF() {
    const month     = document.getElementById('export-month').value;
    const monthLabel = month
      ? new Date(month + '-02').toLocaleString('default', { month: 'long', year: 'numeric' })
      : 'All Time';

    const qMonth = month ? `?month=${month}` : '';
    const qLimit = '&limit=500';

    const [txData, summary, budgets] = await Promise.all([
      fetch('/api/transactions' + qMonth.replace('?','?') + (month ? qLimit : '?limit=500')).then(r => r.json()),
      month ? fetch('/api/transactions/summary' + qMonth).then(r => r.json()) : Promise.resolve(null),
      month ? fetch('/api/budgets/status' + qMonth).then(r => r.json()).catch(() => []) : Promise.resolve([])
    ]);

    const rows = txData.rows || [];
    const fmt  = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

    // Payee initials avatar (no external img for print)
    const COLORS = ['#6c8ef5','#a78bfa','#34d399','#fbbf24','#f87171','#60a5fa','#f472b6','#fb923c'];
    const avatar = (payee, amount) => {
      if (amount > 0) return `<span class="av" style="background:#34d399">$</span>`;
      let h = 0;
      for (const c of String(payee)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
      const col = COLORS[Math.abs(h) % COLORS.length];
      return `<span class="av" style="background:${col}">${(payee.trim()[0] || '?').toUpperCase()}</span>`;
    };

    const txRows = rows.map(r => `
      <tr>
        <td>${r.date}</td>
        <td><span class="payee-cell">${avatar(r.payee, r.amount)}<span>${r.payee || ''}</span></span></td>
        <td>${r.category || '—'}</td>
        <td class="${r.amount >= 0 ? 'income' : 'expense'}" style="text-align:right">${fmt(r.amount)}</td>
        <td style="color:#666">${r.notes || ''}</td>
      </tr>`).join('');

    const summaryHtml = summary ? `
      <div class="summary-row">
        <div class="sum-box"><div class="sum-label">Income</div><div class="sum-val income">${fmt(summary.income)}</div></div>
        <div class="sum-box"><div class="sum-label">Expenses</div><div class="sum-val expense">${fmt(Math.abs(summary.expenses))}</div></div>
        <div class="sum-box"><div class="sum-label">Net</div><div class="sum-val ${summary.net >= 0 ? 'income' : 'expense'}">${fmt(summary.net)}</div></div>
        <div class="sum-box"><div class="sum-label">Transactions</div><div class="sum-val">${rows.length}</div></div>
      </div>` : '';

    const budgetHtml = budgets.length > 0 ? `
      <h2 style="margin:28px 0 10px">Budget Status</h2>
      <table>
        <thead><tr><th>Category</th><th style="text-align:right">Budget</th><th style="text-align:right">Spent</th><th style="text-align:right">Remaining</th><th>Status</th></tr></thead>
        <tbody>
          ${budgets.map(b => {
            const pct  = b.budget > 0 ? b.spent / b.budget * 100 : 0;
            const rem  = b.budget - b.spent;
            const col  = pct > 100 ? '#f87171' : pct >= 80 ? '#fbbf24' : '#34d399';
            const lbl  = pct > 100 ? 'Over' : pct >= 80 ? 'Near limit' : 'On track';
            return `<tr>
              <td>${b.category}</td>
              <td style="text-align:right">${fmt(b.budget)}</td>
              <td style="text-align:right">${fmt(b.spent)}</td>
              <td style="text-align:right;color:${rem < 0 ? '#f87171' : '#34d399'}">${fmt(rem)}</td>
              <td><span style="color:${col};font-weight:600">${lbl} (${pct.toFixed(0)}%)</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>MyFinanceHub — ${monthLabel}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #1a1a2e; padding: 32px; }
      .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #6c8ef5; padding-bottom: 12px; margin-bottom: 20px; }
      .header h1 { font-size: 22px; color: #6c8ef5; }
      .header .sub { font-size: 12px; color: #666; margin-top: 4px; }
      .summary-row { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 24px; }
      .sum-box { background: #f5f5fa; border-radius: 8px; padding: 12px 14px; }
      .sum-label { font-size: 11px; color: #888; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
      .sum-val { font-size: 18px; font-weight: 700; }
      .income { color: #16a34a; }
      .expense { color: #dc2626; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #f0f0f8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #555; padding: 8px 10px; text-align: left; }
      td { padding: 7px 10px; border-bottom: 1px solid #eee; vertical-align: middle; }
      tr:last-child td { border-bottom: none; }
      h2 { font-size: 15px; color: #333; margin-bottom: 10px; }
      .payee-cell { display: flex; align-items: center; gap: 8px; }
      .av { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; flex-shrink: 0; }
      .footer { margin-top: 32px; font-size: 11px; color: #aaa; text-align: center; border-top: 1px solid #eee; padding-top: 12px; }
      @media print { body { padding: 16px; } }
    </style>
    </head><body>
      <div class="header">
        <div>
          <h1>MyFinanceHub</h1>
          <div class="sub">Monthly Report — ${monthLabel}</div>
        </div>
        <div style="font-size:12px;color:#888">Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</div>
      </div>

      ${summaryHtml}

      ${budgetHtml}

      <h2 style="margin-bottom:10px;${budgets.length ? 'margin-top:28px' : ''}">Transactions (${rows.length})</h2>
      <table>
        <thead><tr><th>Date</th><th>Payee</th><th>Category</th><th style="text-align:right">Amount</th><th>Notes</th></tr></thead>
        <tbody>${txRows}</tbody>
      </table>

      <div class="footer">MyFinanceHub · ${monthLabel} · ${rows.length} transactions</div>

      <script>window.onload = () => window.print();<\/script>
    </body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
  }
};
