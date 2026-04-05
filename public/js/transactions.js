const transactionsModule = {
  page: 0,
  pageSize: 50,
  filters: {},
  total: 0,

  async init() {
    this.page = 0;
    this.filters = {};
    await this.render();
  },

  async render() {
    const [categories, payees] = await Promise.all([
      api('/api/categories'),
      api('/api/payees')
    ]);

    const today = new Date().toISOString().slice(0, 7);

    document.getElementById('view').innerHTML = `
      <div class="page-title-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h1 style="margin-bottom:0">Transactions</h1>
        <button class="btn btn-primary" onclick="transactionsModule.openAddModal()">+ Add</button>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div class="filter-bar">
          <div class="form-group filter-month">
            <label>Month</label>
            <input type="month" id="filter-month" value="${today}">
          </div>
          <div class="form-group filter-search">
            <label>Search</label>
            <input type="text" id="filter-search" placeholder="Payee, notes, category…">
          </div>
          <div class="form-group filter-category">
            <label>Category</label>
            <select id="filter-category">
              <option value="">All Categories</option>
              ${categories.map(c => `<option>${c}</option>`).join('')}
            </select>
          </div>
          <div class="filter-actions">
            <button class="btn btn-primary" onclick="transactionsModule.applyFilters()">Filter</button>
            <button class="btn btn-ghost" onclick="transactionsModule.clearFilters()">Clear</button>
          </div>
        </div>
      </div>

      <div id="summary-row" style="margin-bottom:16px"></div>

      <div class="card">
        <div class="table-wrap">
          <table class="tx-table">
            <thead>
              <tr>
                <th>Date</th><th>Payee</th><th>Category</th>
                <th style="text-align:right">Amount</th><th>Notes</th><th>Actions</th>
              </tr>
            </thead>
            <tbody id="tx-body">
              <tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="pagination" id="tx-pagination"></div>
      </div>
    `;

    document.getElementById('filter-month').addEventListener('keydown', e => { if (e.key === 'Enter') this.applyFilters(); });
    document.getElementById('filter-search').addEventListener('keydown', e => { if (e.key === 'Enter') this.applyFilters(); });

    await this.loadRows();
  },

  async applyFilters() {
    this.page = 0;
    this.filters = {
      month: document.getElementById('filter-month')?.value || '',
      search: document.getElementById('filter-search')?.value || '',
      category: document.getElementById('filter-category')?.value || ''
    };
    await this.loadRows();
  },

  async clearFilters() {
    this.page = 0;
    this.filters = {};
    const today = new Date().toISOString().slice(0, 7);
    document.getElementById('filter-month').value = today;
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-category').value = '';
    await this.loadRows();
  },

  async loadRows() {
    const params = new URLSearchParams({
      limit: this.pageSize,
      offset: this.page * this.pageSize,
      ...this.filters
    });
    const { rows, total } = await api(`/api/transactions?${params}`);
    this.total = total;

    const month = this.filters.month || new Date().toISOString().slice(0, 7);
    const summary = await api(`/api/transactions/summary?month=${month}`);

    const sumEl = document.getElementById('summary-row');
    if (sumEl) {
      sumEl.innerHTML = `
        <div class="stats-grid" style="margin-bottom:0">
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Income</div>
            <div class="value income" style="font-size:20px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(summary.income)}</div>
          </div>
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Expenses</div>
            <div class="value expense" style="font-size:20px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(summary.expenses))}</div>
          </div>
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Net</div>
            <div class="value ${summary.net >= 0 ? 'income' : 'expense'}" style="font-size:20px">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(summary.net)}</div>
          </div>
          <div class="stat-card" style="padding:14px 18px">
            <div class="label">Transactions</div>
            <div class="value neutral" style="font-size:20px">${total}</div>
          </div>
        </div>
      `;
    }

    const tbody = document.getElementById('tx-body');
    if (!tbody) return;
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state" style="padding:32px"><div class="empty-icon">📭</div><p>No transactions found</p></div></td></tr>`;
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td data-label="Date" style="white-space:nowrap">${fmtDate(r.date)}</td>
          <td data-label="Payee">${escHtml(r.payee)}</td>
          <td data-label="Category">${r.category ? `<span class="badge badge-blue">${escHtml(r.category)}</span>` : '<span class="badge badge-gray">—</span>'}</td>
          <td data-label="Amount" style="text-align:right">${fmt(r.amount)}</td>
          <td data-label="Notes" style="color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.notes || '')}</td>
          <td data-label="Actions" style="white-space:nowrap">
            ${r.receipt_path ? `<button class="btn btn-ghost btn-sm" onclick="viewReceipt('${escHtml(r.receipt_path)}')" title="View receipt">📎</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="transactionsModule.openEditModal(${r.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="transactionsModule.deleteRow(${r.id})">Del</button>
          </td>
        </tr>
      `).join('');
    }

    const pag = document.getElementById('tx-pagination');
    if (pag) {
      const pages = Math.ceil(total / this.pageSize);
      pag.innerHTML = `
        <span>${total} records · Page ${this.page + 1} of ${Math.max(1, pages)}</span>
        <button class="btn btn-ghost btn-sm" onclick="transactionsModule.prevPage()" ${this.page === 0 ? 'disabled' : ''}>← Prev</button>
        <button class="btn btn-ghost btn-sm" onclick="transactionsModule.nextPage()" ${(this.page + 1) * this.pageSize >= total ? 'disabled' : ''}>Next →</button>
      `;
    }
  },

  async prevPage() { if (this.page > 0) { this.page--; await this.loadRows(); } },
  async nextPage() { if ((this.page + 1) * this.pageSize < this.total) { this.page++; await this.loadRows(); } },

  async openAddModal() {
    const today = new Date().toISOString().slice(0, 10);
    const categories = await api('/api/categories').catch(() => []);
    openModal(`
      <h2>Add Transaction</h2>
      <form id="tx-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:16px">
          <label>Type *</label>
          <div class="tx-type-toggle">
            <button type="button" class="toggle-opt toggle-expense active" id="type-expense" onclick="setTxType('expense')">− Expense</button>
            <button type="button" class="toggle-opt toggle-income" id="type-income" onclick="setTxType('income')">+ Income</button>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date *</label>
            <input type="date" id="tx-date" value="${today}" required>
          </div>
          <div class="form-group">
            <label>Payee *</label>
            <input type="text" id="tx-payee" placeholder="e.g. Grocery Store" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount *</label>
            <input type="number" id="tx-amount" step="0.01" min="0.01" placeholder="42.50" required>
          </div>
          <div class="form-group">
            <label style="display:flex;justify-content:space-between;align-items:center">
              Category
              <button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" onclick="manageCategoriesModal()">Manage ✏</button>
            </label>
            ${buildCategorySelect(categories, '')}
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="tx-notes" placeholder="Optional notes…"></textarea>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label>Receipt (optional)</label>
          <input type="file" id="tx-receipt" accept="image/*,.pdf">
          <p style="font-size:11px;color:var(--text-muted);margin-top:6px">JPG, PNG, WebP or PDF · max 10 MB</p>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Add Transaction</button>
        </div>
      </form>
    `);
    document.getElementById('tx-form').onsubmit = e => { e.preventDefault(); this.submitAdd(); };
  },

  async submitAdd() {
    const isExpense = document.getElementById('type-expense').classList.contains('active');
    const rawAmount = parseFloat(document.getElementById('tx-amount').value);
    const body = {
      date: document.getElementById('tx-date').value,
      payee: document.getElementById('tx-payee').value,
      amount: isExpense ? -Math.abs(rawAmount) : Math.abs(rawAmount),
      category: getTxCategory(),
      notes: document.getElementById('tx-notes').value || null
    };
    try {
      const newTx = await api('/api/transactions', { method: 'POST', body });

      // Upload receipt if one was selected
      const receiptFile = document.getElementById('tx-receipt')?.files[0];
      if (receiptFile && newTx?.id) {
        const formData = new FormData();
        formData.append('receipt', receiptFile);
        await fetch(`/api/transactions/${newTx.id}/receipt`, { method: 'POST', body: formData });
      }

      closeModal();
      toast('Transaction added');
      await this.loadRows();
    } catch (e) { toast(e.message, 'error'); }
  },

  async openEditModal(id) {
    const [row, categories] = await Promise.all([
      api(`/api/transactions/${id}`).catch(() => null),
      api('/api/categories').catch(() => [])
    ]);
    if (!row) return;

    const isIncome = row.amount >= 0;
    openModal(`
      <h2>Edit Transaction</h2>
      <form id="tx-edit-form" style="margin-top:16px">
        <div class="form-group" style="margin-bottom:16px">
          <label>Type *</label>
          <div class="tx-type-toggle">
            <button type="button" class="toggle-opt toggle-expense${isIncome ? '' : ' active'}" id="type-expense" onclick="setTxType('expense')">− Expense</button>
            <button type="button" class="toggle-opt toggle-income${isIncome ? ' active' : ''}" id="type-income" onclick="setTxType('income')">+ Income</button>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date *</label>
            <input type="date" id="tx-date" value="${row.date}" required>
          </div>
          <div class="form-group">
            <label>Payee *</label>
            <input type="text" id="tx-payee" value="${escHtml(row.payee)}" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount *</label>
            <input type="number" id="tx-amount" step="0.01" min="0.01" value="${Math.abs(row.amount)}" required>
          </div>
          <div class="form-group">
            <label style="display:flex;justify-content:space-between;align-items:center">
              Category
              <button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" onclick="manageCategoriesModal()">Manage ✏</button>
            </label>
            ${buildCategorySelect(categories, row.category || '')}
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Notes</label>
          <textarea id="tx-notes">${escHtml(row.notes || '')}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label>Receipt (optional)</label>
          <div id="receipt-section">${buildReceiptSection(id, row.receipt_path)}</div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `);
    document.getElementById('tx-edit-form').onsubmit = e => { e.preventDefault(); this.submitEdit(id); };
  },

  async submitEdit(id) {
    const isExpense = document.getElementById('type-expense').classList.contains('active');
    const rawAmount = parseFloat(document.getElementById('tx-amount').value);
    const body = {
      date: document.getElementById('tx-date').value,
      payee: document.getElementById('tx-payee').value,
      amount: isExpense ? -Math.abs(rawAmount) : Math.abs(rawAmount),
      category: getTxCategory(),
      notes: document.getElementById('tx-notes').value || null
    };
    try {
      await api(`/api/transactions/${id}`, { method: 'PUT', body });
      closeModal();
      toast('Transaction updated');
      await this.loadRows();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteRow(id) {
    if (!confirm('Delete this transaction?')) return;
    try {
      await api(`/api/transactions/${id}`, { method: 'DELETE' });
      toast('Transaction deleted');
      await this.loadRows();
    } catch (e) { toast(e.message, 'error'); }
  }
};

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setTxType(type) {
  document.getElementById('type-expense').classList.toggle('active', type === 'expense');
  document.getElementById('type-income').classList.toggle('active', type === 'income');
}

function buildCategorySelect(categories, selected) {
  const opts = categories.map(c =>
    `<option value="${escHtml(c)}" ${c === selected ? 'selected' : ''}>${escHtml(c)}</option>`
  ).join('');
  return `
    <select id="tx-category" onchange="onCategoryChange()">
      <option value="">— No category —</option>
      ${opts}
      <option value="__new__">＋ New category…</option>
    </select>
    <input type="text" id="tx-category-new" placeholder="Type new category name…"
      style="display:none;margin-top:8px" oninput="this.value=this.value">
  `;
}

function onCategoryChange() {
  const sel = document.getElementById('tx-category');
  const inp = document.getElementById('tx-category-new');
  if (!inp) return;
  inp.style.display = sel.value === '__new__' ? 'block' : 'none';
  if (sel.value === '__new__') inp.focus();
}

function getTxCategory() {
  const sel = document.getElementById('tx-category');
  if (!sel) return null;
  if (sel.value === '__new__') {
    return document.getElementById('tx-category-new')?.value?.trim() || null;
  }
  return sel.value || null;
}

async function manageCategoriesModal() {
  const categories = await api('/api/categories').catch(() => []);

  const renderList = (cats) => cats.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No categories yet.</p>'
    : cats.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:14px">${escHtml(c)}</span>
          <button class="btn btn-danger btn-sm" onclick="deleteCategory('${escHtml(c)}')">Remove</button>
        </div>`).join('');

  openModal(`
    <h2>Manage Categories</h2>
    <div style="margin:16px 0 20px">
      <div style="display:flex;gap:8px">
        <input type="text" id="new-cat-input" placeholder="New category name…" style="flex:1"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addCategory()}">
        <button class="btn btn-primary" onclick="addCategory()">Add</button>
      </div>
    </div>
    <div id="cat-list">${renderList(categories)}</div>
  `);
}

async function addCategory() {
  const inp = document.getElementById('new-cat-input');
  const name = inp?.value?.trim();
  if (!name) return;
  try {
    await api('/api/categories', { method: 'POST', body: { name } });
    inp.value = '';
    const cats = await api('/api/categories');
    document.getElementById('cat-list').innerHTML = cats.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No categories yet.</p>'
      : cats.map(c => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:14px">${escHtml(c)}</span>
            <button class="btn btn-danger btn-sm" onclick="deleteCategory('${escHtml(c)}')">Remove</button>
          </div>`).join('');
    toast(`"${name}" added`);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Receipt helpers ──────────────────────────────────────────────────────────

function buildReceiptSection(txId, receiptPath) {
  const isImage = receiptPath && /\.(jpg|jpeg|png|webp)$/i.test(receiptPath);
  const isPdf   = receiptPath && /\.pdf$/i.test(receiptPath);

  const existing = receiptPath ? `
    <div class="receipt-preview" id="receipt-preview">
      ${isImage
        ? `<a href="/receipts/${receiptPath}" target="_blank">
             <img src="/receipts/${receiptPath}" alt="Receipt" style="max-width:100%;max-height:160px;border-radius:6px;border:1px solid var(--border)">
           </a>`
        : isPdf
          ? `<a href="/receipts/${receiptPath}" target="_blank" class="btn btn-ghost btn-sm">📄 View PDF Receipt</a>`
          : ''
      }
      <div style="margin-top:8px">
        <button type="button" class="btn btn-danger btn-sm" onclick="removeReceipt(${txId})">Remove Receipt</button>
      </div>
    </div>` : '';

  return `
    ${existing}
    <div id="receipt-upload" style="margin-top:${receiptPath ? '12px' : '0'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="receipt-file" accept="image/*,.pdf" style="flex:1;min-width:0">
        <button type="button" class="btn btn-ghost btn-sm" onclick="uploadReceipt(${txId})">Upload</button>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:6px">JPG, PNG, WebP or PDF · max 10 MB</p>
    </div>
  `;
}

async function uploadReceipt(txId) {
  const fileInput = document.getElementById('receipt-file');
  const file = fileInput?.files[0];
  if (!file) { toast('Select a file first', 'error'); return; }

  const formData = new FormData();
  formData.append('receipt', file);

  try {
    const res = await fetch(`/api/transactions/${txId}/receipt`, { method: 'POST', body: formData });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Upload failed'); }
    const data = await res.json();
    document.getElementById('receipt-section').innerHTML = buildReceiptSection(txId, data.receipt_path);
    toast('Receipt uploaded');
  } catch (e) { toast(e.message, 'error'); }
}

async function removeReceipt(txId) {
  if (!confirm('Remove this receipt?')) return;
  try {
    await api(`/api/transactions/${txId}/receipt`, { method: 'DELETE' });
    document.getElementById('receipt-section').innerHTML = buildReceiptSection(txId, null);
    toast('Receipt removed');
  } catch (e) { toast(e.message, 'error'); }
}

function viewReceipt(filename) {
  const isImage = /\.(jpg|jpeg|png|webp)$/i.test(filename);
  if (isImage) {
    openModal(`
      <div style="text-align:center">
        <img src="/receipts/${filename}" alt="Receipt"
          style="max-width:100%;max-height:70vh;border-radius:8px;object-fit:contain">
        <div style="margin-top:12px">
          <a href="/receipts/${filename}" target="_blank" class="btn btn-ghost btn-sm">Open full size ↗</a>
        </div>
      </div>
    `);
  } else {
    window.open(`/receipts/${filename}`, '_blank');
  }
}

async function deleteCategory(name) {
  if (!confirm(`Remove category "${name}"? This won't change existing transactions.`)) return;
  try {
    await api(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const cats = await api('/api/categories');
    document.getElementById('cat-list').innerHTML = cats.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No categories yet.</p>'
      : cats.map(c => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:14px">${escHtml(c)}</span>
            <button class="btn btn-danger btn-sm" onclick="deleteCategory('${escHtml(c)}')">Remove</button>
          </div>`).join('');
    toast(`"${name}" removed`);
  } catch (e) { toast(e.message, 'error'); }
}
