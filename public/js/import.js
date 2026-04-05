const importModule = {
  async init() {
    document.getElementById('view').innerHTML = `
      <h1>Import Transactions</h1>

      <div class="card" style="margin-bottom:20px">
        <h2>Actual Budget CSV Import</h2>
        <p style="color:var(--text-muted);margin-bottom:16px;line-height:1.6">
          Export your transactions from Actual Budget (or any CSV with <strong>Date</strong>, <strong>Payee</strong>, <strong>Amount</strong> columns).
          Duplicate transactions are automatically skipped.
        </p>

        <div style="background:var(--surface2);border-radius:8px;padding:16px;margin-bottom:20px;font-size:12px;color:var(--text-muted)">
          <strong style="color:var(--text)">Supported Formats:</strong><br>
          <ul style="margin:8px 0 0 16px;line-height:2">
            <li>Actual Budget: <code>Date, Payee, Category, Amount, Notes</code></li>
            <li>Generic bank CSV: <code>Date, Description/Merchant, Amount</code></li>
            <li>Date formats: <code>MM/DD/YYYY</code> or <code>YYYY-MM-DD</code></li>
            <li>Amount: negative = expense, positive = income</li>
          </ul>
        </div>

        <form id="import-form">
          <div class="drop-zone" id="drop-zone" onclick="document.getElementById('csv-file').click()">
            <div class="drop-icon">📂</div>
            <div style="font-size:16px;font-weight:600;margin-bottom:8px">Drop CSV file here or click to browse</div>
            <div style="font-size:12px">Supports .csv files</div>
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

      <div class="card">
        <h2>How to export from Actual Budget</h2>
        <ol style="line-height:2;color:var(--text-muted);padding-left:20px">
          <li>Open Actual Budget</li>
          <li>Navigate to the account you want to export</li>
          <li>Click the three-dot menu or <strong>Export</strong> option</li>
          <li>Choose <strong>Export as CSV</strong></li>
          <li>Upload the downloaded CSV file above</li>
        </ol>
        <p style="margin-top:12px;color:var(--text-muted);font-size:12px">
          You can also import CSVs exported from most banks. The importer auto-detects
          common column names (Description, Merchant, Transaction Amount, etc.)
        </p>
      </div>
    `;

    const fileInput = document.getElementById('csv-file');
    const dropZone = document.getElementById('drop-zone');
    const form = document.getElementById('import-form');

    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) this.setFile(e.target.files[0]);
    });

    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
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
    document.getElementById('import-btn').dataset.file = 'ready';
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

    const btn = document.getElementById('import-btn');
    const status = document.getElementById('import-status');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    status.textContent = '';

    const formData = new FormData();
    formData.append('csvfile', this._file);

    try {
      const res = await fetch('/api/import/csv', { method: 'POST', body: formData });
      const result = await res.json();

      if (!res.ok) throw new Error(result.error);

      const resultEl = document.getElementById('import-result');
      const hasErrors = result.errors && result.errors.length > 0;

      resultEl.innerHTML = `
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
        <div class="import-result error">
          <strong>Error:</strong> ${escHtml(e.message)}
        </div>
      `;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import Transactions';
    }
  }
};
